from typing import Optional
import logging

from ..core import BaseSiteAdapter
from ..models import SiteConfig, SiteType
from .sockbase_adapter import SockbaseAdapter
from .generic_adapter import GenericAdapter
from .kowauta_adapter import KowaUtaAdapter
from .learned_pattern_adapter import LearnedPatternAdapter
from .vomas_adapter import VomasAdapter
from .picrea_adapter import PicreaAdapter
from ..utils.pattern_manager import PatternManager


class AdapterFactory:
    """サイトアダプターのファクトリクラス"""

    @staticmethod
    def create_adapter(
        site_config: SiteConfig,
        llm_client: Optional["LLMClient"] = None,
        pattern_manager: Optional[PatternManager] = None,
        **kwargs,
    ) -> BaseSiteAdapter:
        """設定に基づいてアダプターを作成"""

        logger = logging.getLogger("circle_list_generator")

        logger.debug(
            f"アダプター選択: base_url={site_config.base_url}, site_type={site_config.site_type}"
        )

        # パターンマネージャーがない場合は作成
        if pattern_manager is None:
            pattern_manager = PatternManager()

        # Picreaの場合は専用APIアダプターを使用
        if "picrea.jp" in site_config.base_url.lower():
            logger.info("Picreaアダプターを使用（API直接呼び出し）")
            session = kwargs.get("session")
            return PicreaAdapter(site_config, session=session)

        # ボーマスサイトの場合は専用アダプターを使用
        if "ketto.xsrv.jp/html/mimiken" in site_config.base_url.lower():
            logger.info("ボーマス（THE VOC@LOiD M@STER）アダプターを使用")
            return VomasAdapter(site_config)

        # 声音の宴（kowa-uta.com）はHTML構造が既知なので専用アダプターを優先する
        if "kowa-uta.com" in site_config.base_url.lower():
            logger.info("KowaUtaAdapterを使用")
            return KowaUtaAdapter(site_config)

        # 学習済みパターンがある場合は優先的に使用
        if pattern_manager.has_pattern(site_config.base_url):
            logger.info("学習済みパターンアダプターを使用")
            try:
                return LearnedPatternAdapter(site_config, pattern_manager, llm_client)
            except Exception as e:
                logger.warning(f"学習済みパターンの適用に失敗: {e}")
                # 失敗した場合はフォールバック

                # フォールバック: 元の固定アダプターを使用
                if "kowa-uta.com" in site_config.base_url.lower():
                    logger.info("フォールバック: KowaUtaAdapterを使用")
                    return KowaUtaAdapter(site_config)
                elif site_config.site_type == SiteType.SOCKBASE:
                    logger.info("フォールバック: SockbaseAdapterを使用")
                    return SockbaseAdapter(site_config)

        elif site_config.site_type == SiteType.CIRCLE_MS:
            logger.info("Circle.msアダプター（未実装）のため汎用アダプターを使用")
            return GenericAdapter(site_config, llm_client, pattern_manager)

        elif site_config.site_type == SiteType.COMITIA:
            logger.info("COMITIAアダプター（未実装）のため汎用アダプターを使用")
            return GenericAdapter(site_config, llm_client, pattern_manager)

        else:
            logger.info("汎用アダプターを使用")
            return GenericAdapter(site_config, llm_client, pattern_manager)

    @staticmethod
    def detect_site_type(url: str) -> SiteType:
        """URLからサイトタイプを自動検出"""

        url_lower = url.lower()

        if "sockbase.net" in url_lower:
            return SiteType.SOCKBASE
        elif "circle.ms" in url_lower:
            return SiteType.CIRCLE_MS
        elif "comitia" in url_lower:
            return SiteType.COMITIA
        elif "kowa-uta.com" in url_lower:
            return SiteType.CUSTOM  # kowa-uta用の専用タイプを追加するまではCUSTOM
        else:
            return SiteType.CUSTOM
