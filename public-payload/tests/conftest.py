"""テスト共通設定。

外部API（OpenAI/Gemini/xAI）は決して叩かない。
ネットワークが必要なモジュールは各テストでmockする。
"""

from __future__ import annotations

import sys
from pathlib import Path

# src/ をimport可能にするため、プロジェクトルートをsys.pathに追加
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
