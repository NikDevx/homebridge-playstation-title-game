import json
import os
import sys
import traceback
import time
from psnawp_api import PSNAWP
from psnawp_api.core import psnawp_exceptions

os.environ["PSNAWP_CACHE_DIR"] = "/tmp/psnawp_cache"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(BASE_DIR, "homebridge_psn_data.json")


def save_token_response(token_response):
    """Saves the entire token_response dictionary to a JSON file."""
    if not token_response:
        return
    try:
        with open(TOKEN_FILE, "w") as f:
            json.dump(token_response, f, indent=4)
    except Exception:
        pass


def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    config_token = sys.argv[1]

    try:
        account_ids = json.loads(sys.argv[2])
    except:
        sys.exit(1)

    psnawp = PSNAWP(config_token)

    # 1. Attempt to restore session from a JSON file
    if os.path.exists(TOKEN_FILE) and os.path.getsize(TOKEN_FILE) > 0:
        try:
            with open(TOKEN_FILE, "r") as f:
                saved_response = json.load(f)

            psnawp.authenticator.token_response = saved_response

            psnawp.authenticator.fetch_access_token_from_refresh()
        except Exception:
            psnawp.authenticator.token_response = None

    # 2. If there is no session (or it has expired) authorization via NPSSO.
    if psnawp.authenticator.token_response is None:
        try:
            psnawp.me()
        except psnawp_exceptions.PSNAWPAuthenticationError:
            print("Auth Error: Update NPSSO code!")
            sys.exit(1)
        except Exception:
            print("Auth Error")
            sys.exit(1)

    # 3. Get PSN Data
    try:
        game_title = "Offline"

        for account_id in account_ids:
            try:
                user = psnawp.user(account_id=account_id)
                presence = user.get_presence()

                save_token_response(psnawp.authenticator.token_response)

                if presence.get("basicPresence", {}).get("primaryPlatformInfo", {}).get("onlineStatus") != "online":
                    continue

                title_list = presence.get("basicPresence", {}).get("gameTitleInfoList")
                if title_list:
                    title = title_list[0]["titleName"]
                    print(title[:63])
                    return
                else:
                    print("Not playing")
                    return

            except psnawp_exceptions.PSNAWPTooManyRequests:
                print("Rate limit reached")
                return
            except Exception:
                continue

        print(game_title)

    except Exception:
        traceback.print_exc(file=sys.stderr)
        print("Error parsing data")
        sys.exit(1)


if __name__ == "__main__":
    main()
