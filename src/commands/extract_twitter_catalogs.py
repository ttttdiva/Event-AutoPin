"""
Twitter お品書き抽出コマンド
"""

import asyncio
import argparse
from datetime import datetime
from pathlib import Path
import sys
import os

# プロジェクトルートをパスに追加
# プロジェクトルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# twscrapeのloguruログを抑制（パースエラーをWARNINGに降格）
# Twitter APIのレスポンス形式変更により、一部のツイートがパース失敗することがあるが
# これは機能的には問題なく（スキップされる）、ERRORログが大量に出るのを防ぐ
try:
    from loguru import logger as loguru_logger
    
    def twscrape_log_filter(record):
        """twscrape.modelsからのERRORログをフィルタリング"""
        # twscrape.modelsからのFailed to parse...メッセージはWARNINGとして扱う
        if record["name"].startswith("twscrape.models") or record["name"].startswith("twscrape.queue_client"):
            if "Failed to parse" in record["message"] or "Account timeouted" in record["message"]:
                 # エラーレベルを下げて、表示を抑制する意図
                record["level"] = loguru_logger.level("WARNING")
        return True
    
    # loguruのデフォルトハンドラを再設定してフィルターを適用
    loguru_logger.remove()
    loguru_logger.add(
        sys.stderr,
        filter=twscrape_log_filter,
        format="<level>{time:YYYY-MM-DD HH:mm:ss.SSS}</level> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
        level="INFO" 
    )
except ImportError:
    pass  # loguruがインストールされていない場合は無視

from src.utils.twitter_extractor import TwitterExtractor
from src.utils.catalog_updater import CatalogUpdater
from src.utils.logger import setup_logger


logger = setup_logger(__name__)


async def main():
    """メイン処理"""
    parser = argparse.ArgumentParser(
        description='Twitter からお品書き情報を抽出してevent.jsonに追加'
    )
    parser.add_argument(
        'event_file',
        help='event.json ファイルのパス'
    )
    parser.add_argument(
        '--event-date',
        required=True,
        help='イベント開催日 (YYYY-MM-DD形式)'
    )
    parser.add_argument(
        '--output-dir',
        default='twitter_catalogs',
        help='出力ディレクトリ (デフォルト: twitter_catalogs)'
    )
    parser.add_argument(
        '--days-before',
        type=int,
        default=30,
        help='イベント前何日分のツイートを取得するか (デフォルト: 30)'
    )
    parser.add_argument(
        '--days-after',
        type=int,
        default=7,
        help='イベント後何日分のツイートを取得するか (デフォルト: 7)'
    )
    parser.add_argument(
        '--backup',
        action='store_true',
        help='元のファイルをバックアップする'
    )
    
    args = parser.parse_args()
    
    # イベント日付をパース
    try:
        event_date = datetime.strptime(args.event_date, '%Y-%m-%d')
    except ValueError:
        logger.error("イベント日付は YYYY-MM-DD 形式で指定してください")
        return 1
    
    # ファイルの存在確認
    if not Path(args.event_file).exists():
        logger.error(f"ファイルが見つかりません: {args.event_file}")
        return 1
    
    
    try:
        # Twitter抽出器を初期化
        logger.info("Twitter お品書き抽出を開始します...")
        extractor = TwitterExtractor()
        
        # お品書きを抽出
        results = await extractor.extract_catalogs(
            event_file=args.event_file,
            event_date=event_date,
            output_dir=args.output_dir
        )
        
        # 更新器を初期化
        logger.info("イベントデータを更新します...")
        updater = CatalogUpdater(args.event_file)
        
        # Twitter URLカラムがない場合は追加
        updater.add_twitter_url_column()
        
        # 結果を反映
        updated_count = updater.update_from_results(results)
        
        # 保存
        if args.backup:
            # バックアップ付きで保存（元のファイルを .bak にリネーム）
            output_path = updater.save()
        else:
            # 新しいファイル名で保存
            output_path = str(Path(args.event_file).with_stem(
                Path(args.event_file).stem + '_with_catalogs'
            ))
            output_path = updater.save(output_path)
        
        logger.info(f"\n処理完了:")
        logger.info(f"- 処理したサークル数: {len(results)}")
        logger.info(f"- 更新したサークル数: {updated_count}")
        logger.info(f"- 保存先: {output_path}")
        logger.info(f"- 詳細結果: {args.output_dir}/catalog_extraction_results.json")
        
        # 統計情報を表示
        status_counts = {}
        for info in results.values():
            status = info.get('status', '不明')
            status_counts[status] = status_counts.get(status, 0) + 1
        
        logger.info("\n統計:")
        for status, count in sorted(status_counts.items()):
            logger.info(f"  {status}: {count}")
        
        return 0
        
    except Exception as e:
        logger.error(f"エラーが発生しました: {str(e)}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    # イベントループを実行
    exit_code = asyncio.run(main())
    sys.exit(exit_code)