#!/bin/bash

echo "=== Event AutoPin Python環境のセットアップ ==="

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

echo ""
echo "=== Unlimited OCR環境について ==="
echo "マップOCRは Windows の scripts/setup_unlimited_ocr.bat で作る専用venvを使用します。"
echo "Linux/macOS でOCRを使う場合は scripts/setup_unlimited_ocr.py を Python 3.12 で実行してください。"

echo ""
echo "セットアップが完了しました！"
read -p "Enterキーを押して終了してください..."
