"""
Twitter お品書き抽出モジュール v2
レート制限に対応した改良版
"""

# SQLite問題を解決するためのモンキーパッチ
import sys
try:
    import pysqlite3
    sys.modules['sqlite3'] = pysqlite3
except ImportError:
    pass

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Any, Set
from pathlib import Path
import os
import json
from dotenv import load_dotenv
import time

# twscrape 0.19.1以降の現行X対応XClientTxId生成をそのまま使用する。

from twscrape import API, gather
from twscrape.models import Tweet, User

from ..utils.logger import setup_logger
from ..utils.llm_client import LLMClient
from ..utils.downloader import Downloader

# Logger
logger = setup_logger(__name__)

class TwitterExtractorV2:
    """
    Twitter情報抽出クラス（レート制限対応版）
    
    twscrapeのレート制限仕組み：
    1. 各操作（UserTweets等）は15分間のレート制限がある
    2. アカウントごとに独立してロックが管理される
    3. ロックされたアカウントは15分後に自動的に解放される
    """
    
    def __init__(self, accounts_db_path: str = os.path.join("logs", "accounts.db"), retry_delay: int = 60):
        """
        初期化
        
        Args:
            accounts_db_path: twscrapeのアカウントデータベースパス
            retry_delay: レート制限時のリトライ間隔（秒）
        """
        self.api = API(accounts_db_path)
        self.retry_delay = retry_delay
        self._initialized = False
        
        # お品書き関連キーワード
        self.catalog_keywords = [
            'お品書き', 'おしながき', 'サンプル',
            '新刊', '頒布', 'メニュー',
            'カタログ', 'ラインナップ'
        ]
        
        # 不参加・委託キーワード
        self.absence_keywords = [
            '欠席', '不参加', '委託',
            '通販', '書店', 'booth',
            'とらのあな', 'メロンブックス',
            '別スペース', '友人スペース',
            '合同', '合体'
        ]
        
        # LLMクライアント
        self.llm_client = None
        self.downloader = Downloader()
    
    async def initialize(self):
        """Twitter API の初期化（複数アカウント対応）"""
        if self._initialized:
            return
        
        # 既存アカウントの状態を確認
        accounts = await self.api.pool.accounts_info()
        active_accounts = [acc for acc in accounts if acc.get('active', False)]
        
        logger.info(f"アクティブアカウント数: {len(active_accounts)}/{len(accounts)}")
        
        # 環境変数から設定されているべきアカウントを確認し、不足分を追加
        await self._ensure_all_accounts_added()
        
        # ログイン実行
        await self.api.pool.login_all()
        
        # LLMクライアントの初期化
        api_key = os.getenv('OPENAI_API_KEY')
        if api_key:
            self.llm_client = LLMClient(api_key=api_key)
        
        self._initialized = True
        logger.info("Twitter API initialized successfully")
    
    async def _ensure_all_accounts_added(self):
        """cookiesフォルダから設定されているアカウントがすべて追加されているか確認し、不足分を追加"""
        # 既存のアカウントのユーザー名を取得
        existing_accounts = await self.api.pool.accounts_info()
        existing_usernames = {acc.get('username', '') for acc in existing_accounts}
        
        # cookiesフォルダからCookie情報を読み込み
        all_cookies = self._get_all_cookies_from_files()
        
        # 追加すべきアカウントを収集
        accounts_to_add = []
        for i, cookies in enumerate(all_cookies):
            username = f"twitter_user_{i + 1}"
            if username not in existing_usernames:
                accounts_to_add.append({
                    'username': username,
                    'cookies': cookies
                })
        
        # 不足しているアカウントを追加
        if accounts_to_add:
            logger.info(f"{len(accounts_to_add)}個のアカウントを追加します")
            for account in accounts_to_add:
                await self._add_account(account['username'], account['cookies'])
        else:
            logger.info("すべてのアカウントが既に登録されています")
    
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
    
    async def _add_accounts_from_env(self):
        """環境変数からアカウントを追加（廃止予定・後方互換性のため残す）"""
        await self._ensure_all_accounts_added()
    
    async def _add_account(self, username: str, cookies: str):
        """アカウントを追加"""
        try:
            await self.api.pool.add_account(
                username=username,
                password="dummy_password",
                email=f"{username}@example.com",
                email_password="dummy_email_password",
                cookies=cookies
            )
            logger.info(f"アカウント {username} を追加しました")
        except Exception as e:
            logger.warning(f"アカウント {username} の追加に失敗: {e}")
    
    async def extract_catalog_tweets_with_retry(
        self,
        username: str,
        event_date: datetime,
        days_before: int = 30,
        days_after: int = 7,
        max_retries: int = 3
    ) -> List[Dict[str, Any]]:
        """
        お品書きツイートを抽出（リトライ機能付き）
        
        Args:
            username: Twitter ユーザー名
            event_date: イベント開催日
            days_before: イベント前何日分のツイートを取得するか
            days_after: イベント後何日分のツイートを取得するか
            max_retries: 最大リトライ回数
            
        Returns:
            お品書きツイートのリスト
        """
        for attempt in range(max_retries):
            try:
                return await self.extract_catalog_tweets(
                    username, event_date, days_before, days_after
                )
            except Exception as e:
                error_msg = str(e)
                
                # レート制限エラーの場合
                if "No account available" in error_msg:
                    # 次の利用可能時刻を抽出
                    match = re.search(r'Next available at (\d+:\d+:\d+)', error_msg)
                    if match:
                        next_time = match.group(1)
                        logger.warning(f"レート制限: {next_time} まで待機します（{attempt + 1}/{max_retries}）")
                        
                        # 待機時間を計算
                        wait_seconds = self._calculate_wait_time(next_time)
                        if wait_seconds > 0:
                            await asyncio.sleep(wait_seconds)
                            continue
                    else:
                        logger.warning(f"レート制限: {self.retry_delay}秒待機します（{attempt + 1}/{max_retries}）")
                        await asyncio.sleep(self.retry_delay)
                        continue
                
                # 最後の試行の場合はエラーを再発生
                if attempt == max_retries - 1:
                    raise
                
                logger.error(f"エラーが発生しました: {e}. リトライします（{attempt + 1}/{max_retries}）")
                await asyncio.sleep(self.retry_delay)
        
        return []
    
    def _calculate_wait_time(self, next_time_str: str) -> int:
        """次の利用可能時刻までの待機時間を計算"""
        try:
            # HH:MM:SS形式の時刻を解析
            next_time = datetime.strptime(next_time_str, "%H:%M:%S").time()
            now = datetime.now()
            
            # 今日の指定時刻を作成
            next_datetime = datetime.combine(now.date(), next_time)
            
            # 既に過ぎている場合は明日の時刻にする
            if next_datetime <= now:
                next_datetime += timedelta(days=1)
            
            # 待機秒数を計算
            wait_seconds = (next_datetime - now).total_seconds()
            
            # 最大待機時間は15分
            return min(int(wait_seconds) + 10, 900)  # +10秒の余裕を持たせる
            
        except Exception as e:
            logger.error(f"待機時間の計算に失敗: {e}")
            return self.retry_delay
    
    async def extract_catalog_tweets(
        self,
        username: str,
        event_date: datetime,
        days_before: int = 30,
        days_after: int = 7
    ) -> List[Dict[str, Any]]:
        """
        指定ユーザーのタイムラインからお品書きツイートを抽出
        
        Args:
            username: Twitter ユーザー名
            event_date: イベント開催日
            days_before: イベント前何日分のツイートを取得するか
            days_after: イベント後何日分のツイートを取得するか
            
        Returns:
            お品書きツイートのリスト
        """
        await self.initialize()
        
        # 検索期間を設定（UTC時間として設定）
        start_date = (event_date - timedelta(days=days_before)).replace(tzinfo=timezone.utc)
        end_date = (event_date + timedelta(days=days_after)).replace(tzinfo=timezone.utc)
        
        catalog_tweets = []
        
        try:
            # ユーザー名からユーザー情報を取得
            user = await self.api.user_by_login(username)
            if not user:
                logger.error(f"User @{username} not found")
                return catalog_tweets
            
            logger.info(f"Found user @{username} (ID: {user.id})")
            
            # ユーザーのツイートを取得
            tweets = []
            async for tweet in self.api.user_tweets(user.id, limit=100):
                # 期間内のツイートのみ
                if start_date <= tweet.date <= end_date:
                    tweets.append(tweet)
            
            # お品書き関連ツイート・欠席ツイートをフィルタリング
            for tweet in tweets:
                is_catalog = self._is_catalog_tweet(tweet)
                is_absence = self._is_absence_tweet(tweet)

                # お品書きツイートまたは欠席ツイートの場合に抽出
                if is_catalog or is_absence:
                    tweet_data = {
                        'id': tweet.id,
                        'text': tweet.rawContent,
                        'date': tweet.date,
                        'media': [media.url for media in tweet.media.photos] if tweet.media else [],
                        'is_absence': is_absence,
                        'url': f"https://twitter.com/{username}/status/{tweet.id}"
                    }
                    catalog_tweets.append(tweet_data)
            
            logger.info(f"Found {len(catalog_tweets)} catalog tweets for @{username}")
            
        except Exception as e:
            logger.error(f"Error extracting tweets for @{username}: {str(e)}")
            raise  # エラーを再発生させてリトライ処理に委ねる
        
        return catalog_tweets
    
    def _is_catalog_tweet(self, tweet: Tweet) -> bool:
        """お品書きツイートかどうか判定"""
        # リツイート（リポスト）を除外
        if hasattr(tweet, 'retweetedTweet') and tweet.retweetedTweet:
            return False
        
        text = tweet.rawContent.lower()
        
        # キーワードマッチング
        for keyword in self.catalog_keywords:
            if keyword in text:
                return True
        
        # 画像付きツイートで、イベント関連の文言がある場合
        if tweet.media and any(word in text for word in ['参加', 'スペース', 'ブース']):
            return True
        
        return False
    
    def _is_absence_tweet(self, tweet: Tweet) -> bool:
        """不参加・委託ツイートかどうか判定"""
        text = tweet.rawContent.lower()
        
        for keyword in self.absence_keywords:
            if keyword in text:
                return True
        
        return False
    
    async def process_multiple_circles(
        self,
        circles: List[Dict[str, str]],
        event_date: datetime,
        days_before: int = 30,
        days_after: int = 7,
        concurrent_limit: int = 3
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        複数サークルのTwitter情報を並行処理
        
        Args:
            circles: サークル情報のリスト（twitter_urlを含む）
            event_date: イベント開催日
            days_before: イベント前何日分のツイートを取得するか
            days_after: イベント後何日分のツイートを取得するか
            concurrent_limit: 同時実行数の上限
            
        Returns:
            {サークル名: お品書きツイートリスト} の辞書
        """
        await self.initialize()
        
        results = {}
        semaphore = asyncio.Semaphore(concurrent_limit)
        
        async def process_circle(circle: Dict[str, str]):
            async with semaphore:
                circle_name = circle.get('name', 'Unknown')
                twitter_url = circle.get('twitter_url', '')
                
                if not twitter_url:
                    return circle_name, []
                
                # URLからユーザー名を抽出
                username = twitter_url.rstrip('/').split('/')[-1]
                
                try:
                    logger.info(f"Processing {circle_name} (@{username})")
                    tweets = await self.extract_catalog_tweets_with_retry(
                        username, event_date, days_before, days_after
                    )
                    return circle_name, tweets
                except Exception as e:
                    logger.error(f"Failed to process {circle_name}: {e}")
                    return circle_name, []
        
        # 並行処理を実行
        tasks = [process_circle(circle) for circle in circles]
        completed = await asyncio.gather(*tasks)
        
        # 結果を辞書にまとめる
        for circle_name, tweets in completed:
            results[circle_name] = tweets
        
        return results
    
    async def analyze_catalog_image(self, image_url: str, save_dir: Path, circle_name: str = "") -> Dict[str, Any]:
        """
        お品書き画像を解析して情報を抽出
        （既存の実装を流用）
        """
        if not self.llm_client:
            logger.warning("LLMクライアントが初期化されていません")
            return {}
        
        try:
            # 画像をダウンロード
            filename = f"catalog_{circle_name}_{Path(image_url).name}"
            image_path = save_dir / filename
            
            success = self.downloader.download_file(
                image_url, 
                image_path,
                f"お品書き画像 ({circle_name})"
            )
            
            if not success:
                return {}
            
            # LLMで解析
            prompt = """
            このお品書き画像から以下の情報を抽出してください：
            1. 作品タイトル
            2. 価格
            3. ジャンル/カテゴリ
            4. 説明文
            
            JSON形式で回答してください。
            """
            
            result = await self.llm_client.analyze_image(
                image_path,
                prompt
            )
            
            return json.loads(result) if result else {}
            
        except Exception as e:
            logger.error(f"画像解析エラー: {e}")
            return {}
