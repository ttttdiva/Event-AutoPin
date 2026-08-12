#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
セットアップスクリプト
依存関係のチェック、.envファイルの作成、config.yamlの確認を行う
"""

import os
import sys
import subprocess
from pathlib import Path
from typing import List, Dict, Any


class SetupTool:
    """セットアップツール"""
    
    def __init__(self):
        self.project_root = Path(__file__).parent
        self.errors = []
        self.warnings = []
    
    def run(self):
        """セットアップを実行"""
        print("=== サークルリスト生成ツール セットアップ ===\n")
        
        # 1. Python バージョンチェック
        self.check_python_version()
        
        # 2. 依存関係チェック
        self.check_dependencies()
        
        # 3. ディレクトリ作成
        self.create_directories()
        
        # 4. 環境変数ファイル作成
        self.setup_env_file()
        
        # 5. 設定ファイルチェック
        self.check_config_file()
        
        # 結果表示
        self.show_results()
    
    def check_python_version(self):
        """Pythonバージョンをチェック"""
        print("1. Pythonバージョンチェック...")
        
        version = sys.version_info
        if version.major < 3 or (version.major == 3 and version.minor < 8):
            self.errors.append("Python 3.8以上が必要です")
        else:
            print(f"  ✅ Python {version.major}.{version.minor}.{version.micro}")
    
    def check_dependencies(self):
        """依存関係をチェック"""
        print("\n2. 依存関係チェック...")
        
        # パッケージのインポートチェック
        required_packages = {
            'requests': 'requests',
            'bs4': 'beautifulsoup4',
            'pandas': 'pandas',
            'openai': 'openai',
            'dotenv': 'python-dotenv',
            'yaml': 'PyYAML',
            'PIL': 'Pillow',
            'lxml': 'lxml'
        }
        
        missing_packages = []
        for import_name, package_name in required_packages.items():
            try:
                __import__(import_name)
                print(f"  ✅ {package_name}")
            except ImportError:
                missing_packages.append(package_name)
                print(f"  ❌ {package_name}")
        
        if missing_packages:
            self.warnings.append(
                f"以下のパッケージが不足しています: {', '.join(missing_packages)}\n"
                f"  実行してください: pip install -r requirements.txt"
            )
    
    def create_directories(self):
        """必要なディレクトリを作成"""
        print("\n3. ディレクトリ作成...")
        
        directories = ['output', 'logs', 'config_examples']
        
        for dir_name in directories:
            dir_path = self.project_root / dir_name
            dir_path.mkdir(exist_ok=True)
            print(f"  ✅ {dir_name}/")
    
    def setup_env_file(self):
        """環境変数ファイルをセットアップ"""
        print("\n4. 環境変数ファイルセットアップ...")
        
        env_path = self.project_root / '.env'
        
        if env_path.exists():
            print("  ✅ .envファイルは既に存在します")
            
            # APIキーの確認
            with open(env_path, 'r', encoding='utf-8') as f:
                content = f.read()
                if 'OPENAI_API_KEY' not in content:
                    self.warnings.append(".envファイルにOPENAI_API_KEYが設定されていません")
        else:
            print("  📝 .envファイルを作成します...")
            
            api_key = input("  OpenAI APIキーを入力してください: ").strip()
            
            if api_key:
                with open(env_path, 'w', encoding='utf-8') as f:
                    f.write(f"OPENAI_API_KEY={api_key}\n")
                print("  ✅ .envファイルを作成しました")
            else:
                self.warnings.append("APIキーが入力されませんでした。後で.envファイルを編集してください")
    
    def check_config_file(self):
        """設定ファイルをチェック"""
        print("\n5. 設定ファイルチェック...")
        
        config_path = self.project_root / 'config.yaml'
        
        if not config_path.exists():
            self.errors.append("config.yamlが見つかりません")
            return
        
        try:
            import yaml
            with open(config_path, 'r', encoding='utf-8') as f:
                config = yaml.safe_load(f)
            
            # 必須項目のチェック
            if not config.get('target', {}).get('url'):
                self.warnings.append("config.yamlにターゲットURLが設定されていません")
            
            print("  ✅ config.yaml")
            
            # 設定内容を表示
            target_url = config.get('target', {}).get('url', '未設定')
            output_format = config.get('output', {}).get('format', 'caico')
            print(f"    - ターゲットURL: {target_url}")
            print(f"    - 出力フォーマット: {output_format}")
            
        except Exception as e:
            self.errors.append(f"config.yamlの読み込みエラー: {e}")
    
    def show_results(self):
        """結果を表示"""
        print("\n" + "=" * 50)
        print("セットアップ結果")
        print("=" * 50)
        
        if self.errors:
            print("\n❌ エラー:")
            for error in self.errors:
                print(f"  - {error}")
        
        if self.warnings:
            print("\n⚠️  警告:")
            for warning in self.warnings:
                print(f"  - {warning}")
        
        if not self.errors:
            print("\n✅ セットアップが完了しました！")
            print("\n次のコマンドでツールを実行できます:")
            print("  python main.py")
            
            if self.warnings:
                print("\n※ 警告事項を確認して、必要に応じて対処してください")
        else:
            print("\n❌ エラーを修正してから再度セットアップを実行してください")
            sys.exit(1)


def main():
    """メイン関数"""
    setup = SetupTool()
    setup.run()


if __name__ == "__main__":
    main()