import requests
import json
from datetime import datetime, timedelta

# get mining data from nanopool
def fetch_mining_data(wallet_address):
    api_url = f"https://xmr.nanopool.org/api/v1/load_account/{wallet_address}"
    
    try:
        response = requests.get(api_url)
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error fetching data: {str(e)}")
        return None
    except json.JSONDecodeError as e:
        print(f"Error parsing API response: {str(e)}")
        return None

# convert hour vals to timestamps
def hour_to_timestamp(hour, reference_date, reference_hour):
    """
    Convert hour value from API to actual timestamp.
    API uses sequential counter - each +1 is 1 hour.
    """
    hour_diff = hour - reference_hour
    time_diff = timedelta(hours=hour_diff)
    
    return reference_date + time_diff

# find epoch boundaries (Wed 12PM to Wed 12PM)
def find_epoch_boundaries(date):
    # Find the previous or current Wednesday at 12PM
    epoch_end = date.replace(hour=12, minute=0, second=0, microsecond=0)
    while epoch_end.weekday() != 2:  # 2 is Wednesday
        epoch_end += timedelta(days=1)
    
    # If date is after the found Wednesday 12PM, move to next Wed
    if date > epoch_end:
        epoch_end += timedelta(days=7)
    
    # epoch start is 7 days before epoch end
    epoch_start = epoch_end - timedelta(days=7)
    
    return {"epochStart": epoch_start, "epochEnd": epoch_end}

# find epoch number based on a reference start date
def find_epoch_number(date, reference_epoch_start):
    time_diff = date - reference_epoch_start
    weeks_diff = time_diff.days // 7
    return weeks_diff + 1  

# calculate total shares for an epoch
def calculate_epoch_shares(share_history, epoch_start, epoch_end, reference_date, reference_hour):
    total_shares = 0
    shares_in_epoch = []
    
    for entry in share_history:
        timestamp = hour_to_timestamp(entry["hour"], reference_date, reference_hour)
        
        if epoch_start <= timestamp < epoch_end:
            share_count = int(entry["sum"])
            total_shares += share_count
            shares_in_epoch.append({
                "hour": entry["hour"],
                "timestamp": timestamp.isoformat(),
                "shares": share_count
            })
    
    return {"totalShares": total_shares, "sharesInEpoch": shares_in_epoch}


def main():
    # wallet address
    wallet_address = "8C5gopBP7uHNjPPZWhgUVCSe3s2dy4DLjZRgwhMp8DLpPoXTU5epY2VMKP1Vnc5dwJJ9QDCiKbMjberggTu3qYWiGMYFHzd"
    
    # reference epoch start (first Wed 12PM after Jan 1, 2025)
    reference_epoch_start = datetime(2025, 1, 1)
    while reference_epoch_start.weekday() != 2:  # 2 is Wednesday
        reference_epoch_start += timedelta(days=1)
    
    # set time to 12PM
    reference_epoch_start = reference_epoch_start.replace(hour=12, minute=0, second=0, microsecond=0)
    
    # get current date and epoch
    current_date = datetime.now()
    
    # find current epoch boundaries
    epoch_boundaries = find_epoch_boundaries(current_date)
    epoch_start_date = epoch_boundaries["epochStart"]
    epoch_end_date = epoch_boundaries["epochEnd"]
    
    epoch_number = find_epoch_number(epoch_start_date, reference_epoch_start)
    
    print("Fetching mining data from Nanopool...")
    data = fetch_mining_data(wallet_address)
    
    if not data or not data.get("status") or not data.get("data") or not data.get("data").get("shareRateHistory"):
        print("Error: Bad API response")
        return
    
    # get share history
    share_rate_history = data["data"]["shareRateHistory"]
    
    if len(share_rate_history) == 0:
        print("Error: No share rate history")
        return
    

    reference_hour = 484591  # known hour ID for Apr 13th 09:59:59 UTC+2
    reference_date = datetime(2025, 4, 13, 7, 59, 59) 
    
    # calc shares for current epoch
    epoch_result = calculate_epoch_shares(
        share_rate_history,
        epoch_start_date,
        epoch_end_date,
        reference_date,
        reference_hour
    )
    
    print("")
    print(f"Period: {epoch_start_date.strftime('%Y-%m-%d %H:%M:%S')} UTC to {epoch_end_date.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"Total Shares: {epoch_result['totalShares']:,}")
    print(f"Number of hours with data: {len(epoch_result['sharesInEpoch'])}")

if __name__ == "__main__":
    main()
