# Twitter機能のレート制限対策

## twscrapeのレート制限の仕組み

twscrapeは内部的にレート制限を管理しており、以下の特徴があります：

1. **15分間のロック期間**
   - 各API操作（UserTweets, UserByLogin等）は独立してレート制限される
   - アカウントが使用されると、そのキューで15分間ロックされる
   - SQLiteデータベースでロック状態を管理

2. **エラーメッセージ**
   ```
   No account available for queue "UserTweets". Next available at HH:MM:SS
   ```
   - すべてのアカウントがロックされている場合に発生
   - 次の利用可能時刻が表示される

## 実装した対策

### 1. 自動リトライ機能

`TwitterExtractorV2`では以下の機能を実装：

```python
async def extract_catalog_tweets_with_retry(
    self,
    username: str,
    event_date: datetime,
    days_before: int = 30,
    days_after: int = 7,
    max_retries: int = 3
) -> List[Dict[str, Any]]:
```

- レート制限エラーを検出
- 次の利用可能時刻まで自動的に待機
- 指定回数までリトライ

### 2. 複数アカウント対応

環境変数で複数のTwitterアカウントを設定可能：

```bash
# .envファイル
# メインアカウント（後方互換性）
TWITTER_AUTH_TOKEN=xxxxx
TWITTER_CT0=xxxxx

# 追加アカウント
TWITTER_ACCOUNT_1_TOKEN=xxxxx
TWITTER_ACCOUNT_1_CT0=xxxxx

TWITTER_ACCOUNT_2_TOKEN=xxxxx
TWITTER_ACCOUNT_2_CT0=xxxxx
```

### 3. 並行処理制限

複数サークルを処理する際の同時実行数を制限：

```python
async def process_multiple_circles(
    self,
    circles: List[Dict[str, str]],
    event_date: datetime,
    concurrent_limit: int = 3  # 同時実行数の上限
) -> Dict[str, List[Dict[str, Any]]]:
```

## 使用方法

### 単一サークルの処理

```python
from src.utils.twitter_extractor_v2 import TwitterExtractorV2

extractor = TwitterExtractorV2(retry_delay=30)
await extractor.initialize()

# リトライ機能付きで実行
tweets = await extractor.extract_catalog_tweets_with_retry(
    username="uni_2225",
    event_date=datetime(2025, 6, 30),
    max_retries=3
)
```

### 複数サークルの並行処理

```python
circles = [
    {'name': 'サークル1', 'twitter_url': 'https://x.com/circle1'},
    {'name': 'サークル2', 'twitter_url': 'https://x.com/circle2'},
    # ...
]

results = await extractor.process_multiple_circles(
    circles=circles,
    event_date=event_date,
    concurrent_limit=3  # 同時に3サークルまで処理
)
```

## ベストプラクティス

1. **複数アカウントの準備**
   - 大量のサークルを処理する場合は複数のTwitterアカウントを用意
   - 各アカウントのCookieを環境変数に設定

2. **適切な同時実行数**
   - `concurrent_limit`を2-3程度に設定
   - アカウント数に応じて調整

3. **エラーハンドリング**
   - 個別のサークルでエラーが発生しても処理を継続
   - エラーログを確認して原因を特定

4. **待機時間の考慮**
   - 15分のロック期間があるため、大量処理には時間がかかる
   - 夜間バッチなど、時間に余裕がある時に実行

## トラブルシューティング

### レート制限に頻繁に引っかかる場合

1. アカウント数を増やす
2. `concurrent_limit`を下げる
3. 処理間隔を空ける

### アカウントがロックされた場合

```bash
# twscrapeのCLIでロックをリセット
twscrape reset_locks
```

### Cookie が無効になった場合

1. Twitterに再ログイン
2. 新しいCookieを取得
3. .envファイルを更新
4. accounts.dbを削除して再初期化（※accounts.dbはtwscrape使用時のみ生成、現在未使用）