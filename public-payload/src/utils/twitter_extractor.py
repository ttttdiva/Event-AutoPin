"""
Twitter お品書き抽出モジュール
twscrapeを使用してサークルのTwitterからお品書き情報を抽出する
"""

# SQLite問題を解決するためのモンキーパッチ
# WSL環境でSQLiteの古いバージョンが原因でtwscrapeが動作しない問題を回避
import sys
try:
    import pysqlite3
    sys.modules['sqlite3'] = pysqlite3
except ImportError:
    pass

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Any, Union
from pathlib import Path
import os
import json
from dotenv import load_dotenv

from twscrape import API, gather
try:
    from twscrape.accounts_pool import NoAccountError
except ImportError:
    NoAccountError = None
from twscrape.models import Tweet
import httpx
from twscrape.utils import to_old_rep, get_typed_object
from collections import defaultdict
from typing import Generator
import twscrape.models
import twscrape.api

# --- Monkey Patch for twscrape to handle missing user info ---
def robust_parse_tweets(rep: httpx.Response, limit: int = -1) -> Generator[Tweet, None, None]:
    """
    修正版parse_tweets関数 - ユーザー情報欠落エラーを修正
    
    Twitter APIレスポンスの形式変更により、to_old_rep()がユーザー情報を
    正しく抽出できないケースがある。このパッチではツイートJSONから直接
    ユーザー情報を抽出し、obj["users"]に補完してからパースを行う。
    """
    res = rep if isinstance(rep, dict) else rep.json()
    obj = to_old_rep(res)
    
    def _extract_and_add_user(tweet_raw: dict, users_dict: dict) -> None:
        """ツイートのJSONからユーザー情報を抽出してusers_dictに追加"""
        # ユーザー情報の抽出パス（複数の形式に対応）
        user_paths = [
            ("core", "user_results", "result"),
            ("tweet", "core", "user_results", "result"),
        ]
        
        for path in user_paths:
            user_data = tweet_raw
            try:
                for key in path:
                    user_data = user_data[key]
                
                # ユーザーデータが存在し、rest_idがある場合
                if isinstance(user_data, dict) and "rest_id" in user_data:
                    user_id_str = str(user_data["rest_id"])
                    
                    # 既にusers_dictに存在する場合はスキップ
                    if user_id_str in users_dict:
                        continue
                    
                    # legacyデータがある場合は古い形式に変換して追加
                    if "legacy" in user_data:
                        users_dict[user_id_str] = {
                            **user_data,
                            **user_data["legacy"],
                            "id_str": user_id_str,
                            "id": int(user_id_str),
                            "legacy": None,
                        }
            except (KeyError, TypeError):
                continue
    
    ids = set()
    for x in obj["tweets"].values():
        try:
            # パース前にユーザー情報を補完（KeyError対策）
            user_id_str = x.get("user_id_str")
            if user_id_str and user_id_str not in obj["users"]:
                # 元のレスポンスからユーザー情報を探索して追加
                # Tweetオブジェクトからユーザー情報を抽出
                typed_objects = get_typed_object(res, defaultdict(list))
                
                for tweet_raw in typed_objects.get("Tweet", []):
                    _extract_and_add_user(tweet_raw, obj["users"])
                
                # TweetWithVisibilityResultsからも抽出
                for tweet_wrapper in typed_objects.get("TweetWithVisibilityResults", []):
                    if "tweet" in tweet_wrapper:
                        _extract_and_add_user(tweet_wrapper["tweet"], obj["users"])
            
            tmp = Tweet.parse(x, obj)
            if tmp.id not in ids:
                ids.add(tmp.id)
                yield tmp
                if limit != -1 and len(ids) >= limit:
                    break
        except Exception:
            # パース失敗したツイートはスキップ（ログは呼び出し元で抑制済み）
            continue

# Apply monkey patch
twscrape.models.parse_tweets = robust_parse_tweets
twscrape.api.parse_tweets = robust_parse_tweets

# twscrape 0.19.1以降が現行X向けのXClientTxId生成を実装しているため、
# 旧シグネチャ前提のローカルパッチは適用しない。
from ..utils.logger import setup_logger
from ..utils.llm_client import LLMClient
from ..utils.downloader import Downloader


# .envファイルを読み込み
load_dotenv()

logger = setup_logger(__name__)


class CatalogTweetResult(list):
    """Catalog tweet list with per-call checked tweet IDs."""

    def __init__(self, *args, checked_tweet_ids: Optional[List[int]] = None):
        super().__init__(*args)
        self.checked_tweet_ids = checked_tweet_ids or []


class TwitterExtractor:
    """Twitter からお品書き情報を抽出するクラス"""
    
    def __init__(
        self,
        model="gpt-5.6-sol",
        additional_prompt: str = "",
        event_date: str = None,
        cli_providers: Optional[List[str]] = None,
        cli_model_map: Optional[Dict[str, str]] = None,
        cli_effort_map: Optional[Dict[str, str]] = None,
        cli_timeout: int = 900,
        reasoning_effort: Optional[str] = None,
        api_reasoning_effort_map: Optional[Dict[str, str]] = None,
        attempts: Optional[List[Dict[str, Any]]] = None,
    ):
        """初期化

        Args:
            model: 使用するLLMモデル（文字列またはリスト）
            additional_prompt: おしながき判定用の追加プロンプト
            event_date: イベント開催日（YYYY-MM-DD形式）
        """
        self.model = model
        self.additional_prompt = additional_prompt
        # event_dateから日付文字列を自動生成し、LLM用プロンプトに付加
        from .date_utils import format_event_date_jp
        date_jp = format_event_date_jp(event_date) if event_date else None
        if date_jp and additional_prompt:
            self.effective_additional_prompt = f"{date_jp}\n{additional_prompt}"
        elif date_jp:
            self.effective_additional_prompt = date_jp
        else:
            self.effective_additional_prompt = additional_prompt

        # 複数モデル対応のLLMクライアントを初期化
        try:
            self.llm_client = LLMClient(
                model=model,
                cli_providers=cli_providers,
                cli_model_map=cli_model_map,
                cli_effort_map=cli_effort_map,
                cli_timeout=cli_timeout,
                cli_cwd=str(Path(__file__).resolve().parents[2]),
                reasoning_effort=reasoning_effort,
                api_reasoning_effort_map=api_reasoning_effort_map,
                attempts=attempts,
            )
            self.use_gemini = False  # 互換性のためのフラグ（非推奨）
        except Exception as e:
            logger.error(f"LLMクライアントの初期化に失敗: {e}")
            raise

        self.downloader = Downloader()
        self._initialized = False
        self.all_accounts = []  # 全アカウント情報を保持
        self.current_account_index = 0  # 現在使用しているアカウントのインデックス
        self.api_instances = []  # 各アカウント用のAPIインスタンス
        self._twscrape_unavailable_reason: Optional[str] = None

        # お品書き関連キーワード（固定）
        self.catalog_keywords = [
            'お品書き', 'おしながき', '品書き',
            '頒布', '新刊', '既刊', 'スペース',
            'サークル', 'イベント', '参加',
            'ブース', '委託', '通販'
        ]

        # 不参加・委託キーワード
        self.absence_keywords = [
            '不参加', '欠席', '委託',
            '別スペース', '友人スペース',
            '合同', '合体'
        ]

        # 動的キーワード（イベント固有）
        self.dynamic_keywords = []

        # additional_promptからイベント固有キーワードを抽出
        if additional_prompt:
            logger.info("イベント固有のキーワードを抽出中...")
            try:
                self.dynamic_keywords = self.llm_client.extract_event_keywords(additional_prompt)
                if self.dynamic_keywords:
                    logger.info(f"動的キーワードを追加: {self.dynamic_keywords}")
                else:
                    logger.info("動的キーワードは抽出されませんでした")
            except Exception as e:
                logger.warning(f"動的キーワードの抽出に失敗: {e}")
    
    async def initialize(self):
        """Twitter API の初期化（Cookie認証）"""
        if self._initialized:
            return
        
        # すべてのCookie情報を取得
        self.all_accounts = self._get_all_cookies_from_files()
        
        if not self.all_accounts:
            logger.error("利用可能なTwitterアカウントがありません")
            self._show_cookie_setup_help()
            raise ValueError("利用可能なTwitterアカウントがありません")
        
        logger.info(f"合計 {len(self.all_accounts)} 個のTwitterアカウントを検出")
        
        # 各アカウント用のAPIインスタンスを作成
        for i, cookies in enumerate(self.all_accounts):
            api = self._create_api_instance()
            # twscrapeアカウントを追加
            await api.pool.add_account(
                username=f"twitter_user_{i+1}",
                password="dummy_password",
                email=f"dummy{i+1}@example.com",
                email_password="dummy_email_password",
                cookies=cookies
            )
            
            await api.pool.login_all()
            self.api_instances.append(api)
            logger.info(f"Twitter API instance {i+1} initialized successfully")
        
        self._initialized = True
        logger.info(f"すべてのTwitter APIインスタンスの初期化が完了")
    
    def _get_all_cookies_from_files(self) -> List[str]:
        """cookiesフォルダからNetscape形式のCookieファイルを読み込み、Cookie文字列のリストを返す"""
        all_cookies = []
        
        # cookiesフォルダのパスを取得（プロジェクトルート/cookies）
        project_root = Path(__file__).parent.parent.parent
        cookies_dir = project_root / "cookies"
        
        if not cookies_dir.exists():
            logger.warning(f"cookiesフォルダが見つかりません: {cookies_dir}")
            return all_cookies
        
        # Cookieファイルを名前順にソートして処理
        cookie_files = sorted(cookies_dir.glob("*.txt"))
        
        for cookie_file in cookie_files:
            auth_token = None
            ct0 = None
            
            try:
                with open(cookie_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        # コメント行・空行をスキップ
                        if not line or line.startswith('#'):
                            continue
                        
                        # Netscape形式: domain\tflag\tpath\tsecure\texpiry\tname\tvalue
                        parts = line.split('\t')
                        if len(parts) >= 7:
                            name = parts[5]
                            value = parts[6]
                            
                            if name == 'auth_token':
                                auth_token = value
                            elif name == 'ct0':
                                ct0 = value
                
                if auth_token and ct0:
                    all_cookies.append(f"auth_token={auth_token}; ct0={ct0}")
                    logger.info(f"Cookieファイルからアカウントを追加: {cookie_file.name}")
                else:
                    logger.warning(f"auth_tokenまたはct0が見つかりません: {cookie_file.name}")
                    
            except Exception as e:
                logger.error(f"Cookieファイルの読み込みに失敗: {cookie_file.name} - {e}")
        
        return all_cookies

    def _create_api_instance(self) -> API:
        """twscrapeが全アカウントロック時に長時間待たないAPIを作る。"""
        try:
            return API(raise_when_no_account=True)
        except TypeError:
            return API()

    def _is_no_account_error(self, exc: Exception) -> bool:
        if NoAccountError is not None and isinstance(exc, NoAccountError):
            return True
        error_msg = str(exc)
        return (
            "No account available" in error_msg
            or "Could not find any active account" in error_msg
        )

    def _is_twscrape_unknown_error(self, exc: Exception) -> bool:
        error_msg = str(exc)
        return (
            isinstance(exc, IndexError)
            or "list index out of range" in error_msg
            or "Unknown error. Account timeouted" in error_msg
        )

    def _mark_twscrape_unavailable(self, reason: str) -> None:
        if not self._twscrape_unavailable_reason:
            self._twscrape_unavailable_reason = reason
            logger.warning(f"twscrapeを一時停止します: {reason}")
    
    def _get_next_api_instance(self) -> API:
        """次のAPIインスタンスを取得（ラウンドロビン方式）"""
        if not self.api_instances:
            raise ValueError("APIインスタンスが初期化されていません")
        
        api = self.api_instances[self.current_account_index]
        self.current_account_index = (self.current_account_index + 1) % len(self.api_instances)
        return api
    
    def _show_cookie_setup_help(self):
        """Cookie設定方法のヘルプを表示"""
        logger.info("\n=== Twitter Cookie設定方法 ===")
        logger.info("1. Twitterにログイン")
        logger.info("2. 開発者ツール → Application → Cookies → twitter.com")
        logger.info("3. auth_token と ct0 の値をコピー")
        logger.info("4. .envファイルに設定:")
        logger.info('   TWITTER_AUTH_TOKEN=auth_tokenの値')
        logger.info('   TWITTER_CT0=ct0の値')
    
    async def extract_catalog_tweets(
        self,
        username: str,
        event_date: datetime,
        days_before: int = 30,
        days_after: int = 7,
        event_name: str = None,
        skip_tweet_ids: List[int] = None
    ) -> List[Dict[str, Any]]:
        """
        指定ユーザーのタイムラインからお品書きツイートを抽出

        Args:
            username: Twitter ユーザー名
            event_date: イベント開催日
            days_before: イベント前何日分のツイートを取得するか
            days_after: イベント後何日分のツイートを取得するか
            event_name: イベント名
            skip_tweet_ids: スキップするツイートIDのリスト（再処理時に既チェック済みをスキップ）

        Returns:
            お品書きツイートのリスト
        """
        await self.initialize()

        # 検索期間を設定（UTC時間として設定）
        start_date = (event_date - timedelta(days=days_before)).replace(tzinfo=timezone.utc)
        end_date = (event_date + timedelta(days=days_after)).replace(tzinfo=timezone.utc)
        
        catalog_tweets = CatalogTweetResult()

        if self._twscrape_unavailable_reason:
            logger.warning(
                f"twscrape停止中のため@{username}をスキップ: "
                f"{self._twscrape_unavailable_reason}"
            )
            return catalog_tweets
        
        # 複数回試行（アカウントローテーション）
        max_retries = min(3, len(self.api_instances))  # 最大3回またはアカウント数のいずれか小さい方
        last_exception = None
        
        for retry in range(max_retries):
            try:
                # 次のAPIインスタンスを取得
                api = self._get_next_api_instance()
                logger.info(f"アカウント {self.current_account_index + 1}/{len(self.api_instances)} を使用中")
                
                # ユーザー名からユーザー情報を取得
                user = await api.user_by_login(username)
                if not user:
                    logger.error(f"User @{username} not found")
                    return catalog_tweets
                
                logger.info(f"Found user @{username} (ID: {user.id})")
                
                # ユーザーのツイートを取得
                tweets = []
                try:
                    # user_tweets APIを使用（Search APIは不要）
                    logger.info(f"Using user_tweets API for @{username}")
                    logger.info(f"Fetching tweets from {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}")
                    
                    # 期間内のツイートのみ取得するために、limit を調整
                    # イベント前後の期間（デフォルト37日間）なら200件程度で十分
                    # 1日平均5ツイートとしても185件でカバー可能
                    limit = min(200, (days_before + days_after + 1) * 10)
                    
                    tweet_count = 0
                    found_period_tweet = False  # 期間内のツイートを見つけたかどうか
                    
                    async for tweet in api.user_tweets(user.id, limit=limit):
                        tweet_count += 1
                        # 期間内のツイートのみ保存
                        if start_date <= tweet.date <= end_date:
                            tweets.append(tweet)
                            found_period_tweet = True
                        # 期間より前のツイートに到達し、かつ既に期間内のツイートを見つけていたら終了
                        elif tweet.date < start_date and found_period_tweet:
                            logger.info(f"Reached tweets before target period at tweet #{tweet_count}, stopping")
                            break
                        # まだ期間内のツイートを見つけていない場合は継続
                    
                    logger.info(f"Fetched {tweet_count} tweets total, {len(tweets)} within target period")
                    
                    # 成功したらループを抜ける
                    break
                    
                except Exception as e:
                    if self._is_no_account_error(e):
                        logger.warning(f"アカウント {self.current_account_index}/{len(self.api_instances)} でレート制限: {e}")
                        self._mark_twscrape_unavailable(str(e))
                        return catalog_tweets
                    if self._is_twscrape_unknown_error(e):
                        logger.warning(
                            f"twscrapeエラー: @{username} のツイート取得に失敗 "
                            f"({retry + 1}/{max_retries}): {type(e).__name__}: {e}"
                        )
                        last_exception = e
                        if retry < max_retries - 1:
                            continue
                        self._mark_twscrape_unavailable(f"{type(e).__name__}: {e}")
                        return catalog_tweets
                    else:
                        raise
                        
            except Exception as e:
                last_exception = e
                if self._is_no_account_error(e):
                    logger.warning(f"すべてのアカウントが利用不可です: {e}")
                    self._mark_twscrape_unavailable(str(e))
                    return catalog_tweets
                if self._is_twscrape_unknown_error(e):
                    logger.warning(
                        f"twscrapeエラー: @{username} のユーザー取得に失敗 "
                        f"({retry + 1}/{max_retries}): {type(e).__name__}: {e}"
                    )
                    if retry < max_retries - 1:
                        continue
                    self._mark_twscrape_unavailable(f"{type(e).__name__}: {e}")
                    return catalog_tweets
                if retry < max_retries - 1:
                    logger.warning(f"エラーが発生しました: {e}. 別のアカウントで再試行します...")
                    await asyncio.sleep(1)
                    continue
                else:
                    raise
        
        # すべての試行が失敗した場合
        if last_exception and self._is_no_account_error(last_exception):
            logger.warning(f"すべてのアカウントでレート制限に達しました: @{username}")
            self._mark_twscrape_unavailable(str(last_exception))
            return catalog_tweets  # レート制限の場合は空を返す
        
        # tweetsが定義されていない場合（すべて失敗）
        if 'tweets' not in locals():
            return []
        
        # リツイートを除外（retweetedTweetプロパティとユーザーIDで判定）
        original_tweets = []
        seen_tweet_ids = set()  # 重複チェック用
        
        for tweet in tweets:
            # 重複チェック
            if tweet.id in seen_tweet_ids:
                continue
            seen_tweet_ids.add(tweet.id)
            
            # リツイートチェック方法1: retweetedTweetプロパティを確認
            if hasattr(tweet, 'retweetedTweet') and tweet.retweetedTweet is not None:
                logger.debug(f"Filtered out retweet (has retweetedTweet): ID={tweet.id}")
                continue
            
            # リツイートチェック方法2: ツイートのユーザーIDと対象ユーザーのIDを比較
            if hasattr(tweet, 'user') and tweet.user and hasattr(tweet.user, 'id'):
                if str(tweet.user.id) != str(user.id):
                    logger.debug(f"Filtered out retweet: tweet user ID '{tweet.user.id}' != target user ID '{user.id}'")
                    continue
            
            # リツイートチェック方法3: URLのユーザー名で判定（フォールバック）
            if hasattr(tweet, 'url') and tweet.url:
                url_match = re.search(r'twitter\.com/([^/]+)/status/', tweet.url)
                if url_match:
                    url_username = url_match.group(1).lower()
                    if url_username != username.lower():
                        logger.debug(f"Filtered out retweet: URL user '{url_username}' != target user '{username}'")
                        continue
            
            # オリジナルツイートとして追加
            original_tweets.append(tweet)
            
        # チェック済みツイートをスキップ
        if skip_tweet_ids:
            before_count = len(original_tweets)
            original_tweets = [t for t in original_tweets if t.id not in skip_tweet_ids]
            skipped = before_count - len(original_tweets)
            if skipped > 0:
                logger.info(f"Skipped {skipped} already-checked tweets for @{username}")

        # 今回チェックしたツイートIDを記録（checked_tweets.json用）
        checked_tweet_ids = [tweet.id for tweet in original_tweets]
        catalog_tweets.checked_tweet_ids = checked_tweet_ids
        self._last_checked_tweet_ids = checked_tweet_ids

        # お品書き関連ツイートをフィルタリング
        logger.info(f"Processing {len(original_tweets)} original tweets from @{username} (after retweet filtering)")

        # キーワードフィルタで候補を絞る
        keyword_candidates = []
        for tweet in original_tweets:
            logger.debug(f"Checking tweet: ID={tweet.id}, date={tweet.date}, text={tweet.rawContent[:50]}...")
            if self._is_catalog_tweet(tweet) or self._is_absence_tweet(tweet):
                keyword_candidates.append(tweet)

        if not keyword_candidates:
            logger.info(f"No keyword-matched tweets for @{username}")
            return catalog_tweets

        # イベント名が指定されている場合、LLMでバッチ判定
        if event_name and keyword_candidates:
            tweets_data = [
                {
                    "index": i,
                    "text": tweet.rawContent,
                    "date": tweet.date.strftime('%Y-%m-%d %H:%M') if hasattr(tweet.date, 'strftime') else str(tweet.date),
                    "has_media": bool(tweet.media),
                }
                for i, tweet in enumerate(keyword_candidates)
            ]

            loop = asyncio.get_event_loop()
            batch_result = await loop.run_in_executor(
                None,
                self.llm_client.batch_filter_catalog_tweets,
                tweets_data,
                event_name,
                event_date.strftime('%Y-%m-%d'),
                self.effective_additional_prompt,
            )

            catalog_indices = set(batch_result.get('catalog_indices', []))
            absence_indices = set(batch_result.get('absence_indices', []))
            best_index = batch_result.get('best_index')

            logger.info(f"Batch filter for @{username}: catalogs={catalog_indices}, best={best_index}, absences={absence_indices}")

            for i, tweet in enumerate(keyword_candidates):
                if i in catalog_indices or i in absence_indices:
                    tweet_data = {
                        'id': tweet.id,
                        'text': tweet.rawContent,
                        'date': tweet.date,
                        'media': [media.url for media in tweet.media.photos] if tweet.media else [],
                        'is_absence': i in absence_indices,
                        'is_best': i == best_index,
                        'url': f"https://twitter.com/{tweet.user.username}/status/{tweet.id}"
                    }
                    catalog_tweets.append(tweet_data)

            # best_indexが設定されている場合、ベストツイートを先頭に並べ替え
            if best_index is not None and catalog_tweets:
                best_tweets = [t for t in catalog_tweets if t.get('is_best')]
                other_tweets = [t for t in catalog_tweets if not t.get('is_best')]
                catalog_tweets = best_tweets + other_tweets
        else:
            # イベント名なし：キーワードフィルタのみ
            for tweet in keyword_candidates:
                tweet_data = {
                    'id': tweet.id,
                    'text': tweet.rawContent,
                    'date': tweet.date,
                    'media': [media.url for media in tweet.media.photos] if tweet.media else [],
                    'is_absence': self._is_absence_tweet(tweet),
                    'is_best': False,
                    'url': f"https://twitter.com/{tweet.user.username}/status/{tweet.id}"
                }
                catalog_tweets.append(tweet_data)

        logger.info(f"Found {len(catalog_tweets)} catalog tweets for @{username}")

        return catalog_tweets
    
    def _is_catalog_tweet(self, tweet: Tweet) -> bool:
        """お品書きツイートかどうか判定"""
        # リツイートは既に extract_catalog_tweets で除外されているので、
        # ここではお品書き関連のキーワードチェックのみ行う


        text = tweet.rawContent.lower()

        # 固定キーワードマッチング
        for keyword in self.catalog_keywords:
            if keyword in text:
                return True

        # 動的キーワードマッチング（イベント固有）
        for keyword in self.dynamic_keywords:
            if keyword.lower() in text:
                logger.debug(f"Tweet matched dynamic keyword: '{keyword}'")
                return True

        # 画像付きツイートで、イベント関連の文言がある場合
        if tweet.media and any(word in text for word in ['参加', 'スペース', 'ブース']):
            return True

        return False
    
    def _is_absence_tweet(self, tweet: Tweet) -> bool:
        """不参加・委託ツイートかどうか判定"""
        text = tweet.rawContent.lower()

        # 明確な欠席を示すキーワード（単独で欠席と判定）
        strong_absence_keywords = ['不参加', '欠席']
        for keyword in strong_absence_keywords:
            if keyword in text:
                return True

        # 委託・合同などは、参加を否定する文脈でのみ欠席と判定
        weak_absence_keywords = ['委託', '別スペース', '友人スペース', '合同', '合体']

        # 参加を否定する文脈パターン
        # 例: 「委託のみ」「委託参加」「委託になりました」など
        absence_patterns = [
            r'委託のみ',
            r'委託参加',
            r'委託に(?:なり|し)',
            r'(?:別|友人)スペース(?:で|に|から)',
            r'(?:今回|今度|次回).*(?:不参加|欠席|委託)',
            r'(?:申し訳|残念|すみません).*(?:不参加|欠席|委託)',
        ]

        import re
        for pattern in absence_patterns:
            if re.search(pattern, text):
                return True

        # 「参加」という肯定的な文言があれば、弱い欠席キーワードは無視
        positive_keywords = ['参加します', '参加予定', 'いらっしゃい', 'お待ちして', '当日']
        for positive in positive_keywords:
            if positive in text:
                return False

        return False
    
    async def download_catalog_image(self, image_url: str, save_dir: Path, filename: str = "") -> str:
        """
        お品書き画像をダウンロード・処理
        
        Args:
            image_url: 画像URL
            save_dir: 画像保存ディレクトリ
            filename: 保存するファイル名
            
        Returns:
            ダウンロードした画像のパス
        """
        # 画像をダウンロード
        if not filename:
            # 元のファイル名から拡張子を取得
            original_filename = image_url.split('/')[-1]
            # catalog_xxxxx.jpg形式に統一（拡張子を.jpgに変更）
            base_name = original_filename.rsplit('.', 1)[0] if '.' in original_filename else original_filename
            filename = f"catalog_{base_name}.jpg"
        
        # 一時ファイルとしてダウンロード
        temp_path = save_dir / f"temp_{filename}"
        final_path = save_dir / filename
        
        # 同期的にダウンロード（Downloaderクラスは非同期ではない）
        loop = asyncio.get_event_loop()
        success = await loop.run_in_executor(
            None,
            self.downloader.download_file,
            image_url,
            temp_path,
            f"{filename}"
        )
        
        if success and temp_path.exists():
            # JPGとして保存（拡張子を.jpgに統一）
            if temp_path.suffix.lower() != '.jpg':
                from PIL import Image
                img = Image.open(temp_path)
                if img.mode in ('RGBA', 'LA', 'P'):
                    # 透過画像は白背景でRGBに変換
                    rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                    rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                    img = rgb_img
                img.save(final_path, 'JPEG', quality=85)
                temp_path.unlink()  # 一時ファイルを削除
            else:
                # すでにJPGの場合はリネーム
                temp_path.replace(final_path)
        else:
            # ダウンロード失敗時
            if temp_path.exists():
                temp_path.unlink()
            return ""
        
        return str(final_path)
    
    async def extract_catalogs(
        self,
        event_file: str,
        event_date: datetime,
        output_dir: str = "twitter_catalogs",
        debug_limit: int = None
    ) -> Dict[str, Any]:
        """
        イベントファイルからサークル情報を読み込み、お品書きを抽出

        Args:
            event_file: event.jsonのパス
            event_date: イベント開催日
            output_dir: 出力ディレクトリ
            debug_limit: デバッグ用に処理するサークル数を制限
            use_search: Search APIを使用するか（デフォルト: True）
            
        Returns:
            サークルごとのお品書き情報
        """
        # 出力ディレクトリを作成
        output_path = Path(output_dir)
        output_path.mkdir(exist_ok=True)
        
        # event.json を読み込み
        with open(event_file, "r", encoding="utf-8") as f:
            event_data = json.load(f)
        circles = event_data.get("circles", [])
        if not isinstance(circles, list):
            raise ValueError("event.json の circles が配列ではありません")
        
        results = {}
        # 全体で見つかったツイートIDを記録（重複チェック用）
        all_tweet_ids = set()
        
        # デバッグモードの場合は処理数を制限
        if debug_limit:
            logger.info(f"Debug mode: limiting to {debug_limit} circles")
            circles = circles[:debug_limit]

        def first_twitter_url(circle: Dict[str, Any]) -> str:
            for key in ("twitter_url", "x_url"):
                value = str(circle.get(key) or "").strip()
                if value:
                    return value
            memo = str(circle.get("memo") or "")
            match = re.search(r"https?://(?:twitter\.com|x\.com)/[^\s]+", memo)
            return match.group(0) if match else ""

        def safe_dir_name(name: str) -> str:
            return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip() or "circle"
        
        # 各サークルを処理
        for idx, circle in enumerate(circles):
            if not isinstance(circle, dict):
                continue
            circle_name = str(circle.get("name") or "").strip()
            twitter_url = first_twitter_url(circle)
            
            if not twitter_url:
                results[circle_name] = {'status': '不明', 'reason': 'Twitter URL not provided'}
                continue
            
            # Twitter URLからユーザー名を抽出
            username_match = re.search(
                r'(?:twitter\.com|x\.com)/@?([A-Za-z0-9_]+)(?:[/?#]|$)',
                twitter_url,
            )
            if not username_match:
                results[circle_name] = {'status': '不明', 'reason': 'Invalid Twitter URL'}
                continue
            
            username = username_match.group(1)
            
            # お品書きツイートを抽出
            try:
                catalog_tweets = await self.extract_catalog_tweets(
                    username, 
                    event_date
                )
                
                # 重複ツイートを除外（他のサークルで既に見つけたツイート）
                filtered_tweets = []
                for tweet in catalog_tweets:
                    tweet_id = tweet['id']
                    if tweet_id not in all_tweet_ids:
                        all_tweet_ids.add(tweet_id)
                        filtered_tweets.append(tweet)
                    else:
                        logger.info(f"Skipping duplicate tweet {tweet_id} for {circle_name} (already found for another circle)")
                
                catalog_tweets = filtered_tweets
                
                if not catalog_tweets:
                    results[circle_name] = {
                        'status': 'お品書きなし',
                        'twitter_url': twitter_url
                    }
                    continue
                
                # 不参加・委託チェック
                if any(tweet['is_absence'] for tweet in catalog_tweets):
                    absence_tweet = next(t for t in catalog_tweets if t['is_absence'])
                    results[circle_name] = {
                        'status': '不参加/委託',
                        'details': absence_tweet['text'],
                        'twitter_url': twitter_url
                    }
                    continue
                
                # お品書き画像をダウンロード
                circle_dir = output_path / f"{idx:04d}_{safe_dir_name(circle_name)}"
                circle_dir.mkdir(exist_ok=True)
                
                catalogs = []
                for tweet in catalog_tweets:
                    tweet_info = {
                        'text': tweet['text'],
                        'url': tweet['url'],
                        'date': tweet['date'].isoformat()
                    }
                    
                    # 画像をダウンロード（最初の1枚のみ）
                    if tweet['media']:
                        first_image_url = tweet['media'][0]
                        image_path = await self.download_catalog_image(first_image_url, circle_dir, circle_name)
                        tweet_info['image_path'] = image_path
                    
                    catalogs.append(tweet_info)
                
                results[circle_name] = {
                    'status': 'お品書きあり',
                    'catalogs': catalogs,
                    'twitter_url': twitter_url
                }
                
            except Exception as e:
                logger.error(f"Error processing circle {circle_name}: {str(e)}")
                results[circle_name] = {
                    'status': 'エラー',
                    'error': str(e),
                    'twitter_url': twitter_url
                }
        
        # 結果を保存
        result_file = output_path / "catalog_extraction_results.json"
        with open(result_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        
        logger.info(f"Catalog extraction completed. Results saved to {result_file}")
        
        return results
