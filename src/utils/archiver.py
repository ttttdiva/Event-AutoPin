import zipfile
from pathlib import Path
from typing import List, Tuple
import logging


class Archiver:
    """アーカイブ作成クラス"""
    
    def __init__(self, output_dir: Path):
        self.output_dir = Path(output_dir)
        self.logger = logging.getLogger(__name__)
    
    def create_zip(
        self,
        archive_name: str,
        files: List[Tuple[str, Path]],
        compression: bool = True
    ) -> Path:
        """ZIPアーカイブを作成
        
        Args:
            archive_name: アーカイブ名（拡張子なし）
            files: (アーカイブ内パス, 実ファイルパス) のリスト
            compression: 圧縮するかどうか
            
        Returns:
            作成されたアーカイブのパス
        """
        archive_path = self.output_dir / f"{archive_name}.zip"
        
        compression_type = zipfile.ZIP_DEFLATED if compression else zipfile.ZIP_STORED
        
        try:
            with zipfile.ZipFile(archive_path, 'w', compression_type) as zipf:
                for archive_name, file_path in files:
                    if file_path.exists():
                        zipf.write(file_path, archive_name)
                        self.logger.debug(f"アーカイブに追加: {archive_name}")
                    else:
                        self.logger.warning(f"ファイルが見つかりません: {file_path}")
            
            # アーカイブサイズをログ
            size_mb = archive_path.stat().st_size / (1024 * 1024)
            self.logger.info(f"アーカイブ作成完了: {archive_path} ({size_mb:.1f} MB)")
            
            return archive_path
            
        except Exception as e:
            self.logger.error(f"アーカイブ作成エラー: {e}")
            raise