import json
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

class BrowserManager:
    """Manages local Chrome profiles and auto-launches them."""

    def __init__(self):
        self.chrome_dir = Path(os.path.expanduser("~/Library/Application Support/Google/Chrome"))
        self.local_state_path = self.chrome_dir / "Local State"

    def get_profiles(self) -> dict:
        """Parse Local State to find all configured Chrome profiles."""
        if not self.local_state_path.exists():
            logger.warning("Chrome Local State file not found at %s", self.local_state_path)
            # Fallback to standard profiles if Local State doesn't exist
            return {"Default": "Default", "Profile 1": "Profile 1"}

        try:
            with open(self.local_state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            profiles = {}
            info_cache = data.get("profile", {}).get("info_cache", {})
            for dir_name, info in info_cache.items():
                name = info.get("name", dir_name)
                profiles[dir_name] = name
            
            return profiles
        except Exception as e:
            logger.exception("Failed to parse Chrome Local State: %s", e)
            return {"Default": "Default"}

    def launch_profile(self, profile_dir: str):
        """Launch Chrome with the given profile directory minimized."""
        logger.info("Auto-launching Chrome profile: %s", profile_dir)
        try:
            # -j hides the app (launches minimized/in background on macOS)
            # -n forces a new instance if needed
            cmd = [
                "open", "-j", "-n", "-a", "Google Chrome", 
                "--args", f"--profile-directory={profile_dir}",
                "https://labs.google/fx/tools/flow"
            ]
            subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except Exception as e:
            logger.exception("Failed to launch Chrome profile %s: %s", profile_dir, e)

# Singleton
_browser_manager = None

def get_browser_manager() -> BrowserManager:
    global _browser_manager
    if _browser_manager is None:
        _browser_manager = BrowserManager()
    return _browser_manager
