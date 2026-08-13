"""
おしながき画像一括設定スクリプト

memoフィールドにおしながきポストURLがあり、
かつitem_imagesが未設定のサークルに対して、
ポストから画像を取得しておしながき画像を設定する。
"""

# twitter_extractor をインポートしてmonkey patchを適用
import src.utils.twitter_extractor  # noqa: F401 - monkey patch適用のため

import asyncio
import json
import re
import logging
import time
from pathlib import Path
from typing import List, Optional

from twscrape import API
from src.utils.downloader import Downloader
from PIL import Image

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)


def get_all_cookies() -> List[str]:
    """cookiesフォルダからCookie文字列リストを取得"""
    cookies_dir = Path(__file__).parent / "cookies"
    all_cookies = []

    for cookie_file in sorted(cookies_dir.glob("*.txt")):
        auth_token = None
        ct0 = None

        with open(cookie_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
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

    return all_cookies


async def init_api_instances(cookies_list: List[str]) -> List[API]:
    """twscrapeのAPIインスタンスを初期化"""
    instances = []
    for i, cookies in enumerate(cookies_list):
        api = API()
        await api.pool.add_account(
            username=f"twitter_user_{i+1}",
            password="dummy_password",
            email=f"dummy{i+1}@example.com",
            email_password="dummy_email_password",
            cookies=cookies
        )
        await api.pool.login_all()
        instances.append(api)
    return instances


def is_post_url(url: str) -> bool:
    """ポストURLかどうか判定（アカウントURLはFalse）"""
    return '/status/' in url


def extract_tweet_id(url: str) -> Optional[str]:
    """URLからツイートIDを抽出"""
    match = re.search(r'/status/(\d+)', url)
    return match.group(1) if match else None


def download_and_convert_image(img_url: str, save_dir: Path, filename: str, downloader: Downloader) -> str:
    """画像をダウンロードしてJPGに変換"""
    temp_path = save_dir / f"temp_{filename}"
    final_path = save_dir / filename

    if final_path.exists():
        return str(final_path)

    success = downloader.download_file(img_url, temp_path, filename)

    if success and temp_path.exists():
        try:
            img = Image.open(temp_path)
            if img.mode in ('RGBA', 'LA', 'P'):
                rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'RGBA':
                    rgb_img.paste(img, mask=img.split()[-1])
                else:
                    rgb_img.paste(img)
                img = rgb_img
            elif img.mode != 'RGB':
                img = img.convert('RGB')
            img.save(final_path, 'JPEG', quality=85)
            if temp_path.exists() and temp_path != final_path:
                temp_path.unlink()
        except Exception as e:
            logger.error(f"画像変換エラー: {e}")
            if temp_path.exists():
                temp_path.unlink()
            return ""
        return str(final_path)
    else:
        if temp_path.exists():
            temp_path.unlink()
        return ""


async def main():
    events_dir = Path(__file__).parent / "events"
    downloader = Downloader()

    # twscrape初期化
    cookies_list = get_all_cookies()
    if not cookies_list:
        logger.error("Cookieが見つかりません")
        return

    api_instances = await init_api_instances(cookies_list)
    logger.info(f"APIインスタンス {len(api_instances)} 個を初期化")

    api_index = 0

    def get_next_api() -> API:
        nonlocal api_index
        api = api_instances[api_index]
        api_index = (api_index + 1) % len(api_instances)
        return api

    # 全イベントを処理
    total_set = 0
    total_skipped_account = 0
    total_skipped_already = 0
    total_skipped_no_media = 0
    total_skipped_deleted = 0
    total_errors = 0

    for event_dir in sorted(events_dir.iterdir()):
        event_json_path = event_dir / "event.json"
        if not event_json_path.exists():
            continue

        data = json.loads(event_json_path.read_text(encoding='utf-8'))
        circles = data.get('circles', [])
        modified = False

        for circle in circles:
            # 既におしながき画像がある場合はスキップ
            if circle.get('item_images'):
                continue

            memo = circle.get('memo', '')
            if '【お品書きツイート】' not in memo:
                continue

            # memoからURLを抽出
            urls = re.findall(r'https?://(?:twitter\.com|x\.com)/\S+', memo)
            if not urls:
                continue

            # ポストURL（/status/を含む）のみをフィルタ
            post_urls = [u for u in urls if is_post_url(u)]
            if not post_urls:
                total_skipped_account += 1
                logger.info(f"スキップ（アカウントURL）: {circle['name']} @ {event_dir.name}")
                continue

            # 最初のポストURLを使用
            url = post_urls[0]
            tweet_id = extract_tweet_id(url)
            if not tweet_id:
                total_errors += 1
                continue

            # ツイートからメディアを取得
            try:
                tweet = None
                last_err = None
                for attempt in range(3):
                    try:
                        api = get_next_api()
                        tweet = await api.tweet_details(int(tweet_id))
                        break
                    except Exception as e:
                        last_err = e
                        logger.warning(f"tweet_details リトライ {attempt+1}/3: {e}")
                        await asyncio.sleep(2)

                if tweet is None and last_err is not None:
                    error_msg = str(last_err)
                    if 'not found' in error_msg.lower() or '404' in error_msg:
                        total_skipped_deleted += 1
                        logger.info(f"スキップ（削除済み）: {circle['name']} @ {event_dir.name} - {url}")
                    else:
                        total_errors += 1
                        logger.warning(f"取得失敗: {circle['name']} @ {event_dir.name} - {last_err}")
                    continue

                if tweet is None:
                    total_skipped_deleted += 1
                    logger.info(f"スキップ（削除済み/取得不能）: {circle['name']} @ {event_dir.name} - {url}")
                    continue

                if not tweet.media or not tweet.media.photos:
                    total_skipped_no_media += 1
                    logger.info(f"スキップ（画像なし）: {circle['name']} @ {event_dir.name} - {url}")
                    continue

                # 最初の1枚だけを使用
                photo_url = tweet.media.photos[0].url

                # ファイル名を生成
                original_filename = photo_url.split('/')[-1]
                base_name = original_filename.rsplit('.', 1)[0] if '.' in original_filename else original_filename
                catalog_filename = f"catalog_{base_name}.jpg"

                # ダウンロード
                image_path = download_and_convert_image(
                    photo_url, event_dir, catalog_filename, downloader
                )

                if image_path:
                    circle['item_images'] = [{"path": catalog_filename}]
                    modified = True
                    total_set += 1
                    logger.info(f"設定完了: {circle['name']} @ {event_dir.name} -> {catalog_filename}")
                else:
                    total_errors += 1
                    logger.warning(f"ダウンロード失敗: {circle['name']} @ {event_dir.name} - {photo_url}")

            except Exception as e:
                error_msg = str(e)
                if 'not found' in error_msg.lower() or '404' in error_msg:
                    total_skipped_deleted += 1
                    logger.info(f"スキップ（削除済み）: {circle['name']} @ {event_dir.name} - {url}")
                else:
                    total_errors += 1
                    logger.warning(f"エラー: {circle['name']} @ {event_dir.name} - {e}")

        # 変更があればevent.jsonを保存
        if modified:
            event_json_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding='utf-8'
            )
            logger.info(f"event.json更新: {event_dir.name}")

    # サマリー
    logger.info("=" * 60)
    logger.info(f"処理完了サマリー:")
    logger.info(f"  画像設定成功: {total_set}件")
    logger.info(f"  スキップ（アカウントURL）: {total_skipped_account}件")
    logger.info(f"  スキップ（既に設定済み）: {total_skipped_already}件")
    logger.info(f"  スキップ（画像なしポスト）: {total_skipped_no_media}件")
    logger.info(f"  スキップ（削除済みポスト）: {total_skipped_deleted}件")
    logger.info(f"  エラー: {total_errors}件")


if __name__ == "__main__":
    asyncio.run(main())
