import json
import os
import sys
import traceback
import time
from psnawp_api import PSNAWP
from psnawp_api.core import psnawp_exceptions

os.environ["PSNAWP_CACHE_DIR"] = "/tmp/psnawp_cache"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) >= 4:
    TOKEN_FILE = sys.argv[3]
else:
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
    except Exception:
        sys.exit(1)

    psnawp = PSNAWP(config_token)

    # 1. Restore session from JSON
    if os.path.exists(TOKEN_FILE) and os.path.getsize(TOKEN_FILE) > 0:
        try:
            with open(TOKEN_FILE, "r") as f:
                saved_response = json.load(f)

            psnawp.authenticator.token_response = saved_response

            # --- LOCAL EXPIRATION CHECK ---
            current_time = time.time()
            expires_at = saved_response.get("access_token_expires_at", 0)

            # If access_token has expired or is about to expire in less than 11 minutes and 40 seconds
            if expires_at - current_time < 700:
                psnawp.authenticator.fetch_access_token_from_refresh()

                new_expires_in = psnawp.authenticator.token_response.get("expires_in", 3600)
                psnawp.authenticator.token_response["access_token_expires_at"] = time.time() + new_expires_in
                psnawp.authenticator.token_response["refresh_token_expires_at"] = time.time() + 864000

                save_token_response(psnawp.authenticator.token_response)

        except Exception:
            psnawp.authenticator.token_response = None

    # 2. If no session exists (first run) — authenticate via NPSSO
    if psnawp.authenticator.token_response is None:
        try:
            psnawp.me()  # This method triggers login via NPSSO
            save_token_response(psnawp.authenticator.token_response)
        except psnawp_exceptions.PSNAWPAuthenticationError:
            print("Auth Error: Update NPSSO code!")
            sys.exit(1)
        except Exception:
            print("Auth Error")
            sys.exit(1)

    # 3. Fetch PSN Data
    try:
        game_title = "Loading"

        # STORE the initial access token before making requests
        initial_access_token = None
        if psnawp.authenticator.token_response:
            initial_access_token = psnawp.authenticator.token_response.get("access_token")

        for account_id in account_ids:
            try:
                user = psnawp.user(account_id=account_id)
                presence = user.get_presence()

                # CHECK if the access token was updated after the request
                current_access_token = psnawp.authenticator.token_response.get("access_token")

                if current_access_token != initial_access_token:
                    save_token_response(psnawp.authenticator.token_response)
                    initial_access_token = current_access_token

                if presence.get("basicPresence", {}).get("primaryPlatformInfo", {}).get("onlineStatus") != "online":
                    continue

                title_list = presence.get("basicPresence", {}).get("gameTitleInfoList")

                if title_list:
                    game_title = title_list[0]["titleName"][:63]
                else:
                    game_title = "Not playing"
                break

            except psnawp_exceptions.PSNAWPTooManyRequests:
                game_title = "Rate limit reached"
                break
            except Exception:
                continue

        if game_title == "Loading":
            game_title = "Offline"

        print(game_title)

    except Exception:
        traceback.print_exc(file=sys.stderr)
        print("Error parsing data")
        sys.exit(1)


if __name__ == "__main__":
    main()
