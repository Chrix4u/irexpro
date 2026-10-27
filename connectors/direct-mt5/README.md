# iRexPro Direct MT5 DEMO connector
On the Windows PC/VPS where MetaTrader 5 is installed and logged into a **DEMO** account:

1. Install Python 3.11+ and run `py -m pip install MetaTrader5`.
2. In iRexPro choose **MetaTrader 5 → Direct Terminal**, enter the numeric MT5 login, and create a pairing code.
3. Run: `py irexpro_mt5_connector.py --api-base https://<irexpro-api-host>/api --pairing-code <CODE>`.
4. Keep the connector running beside MT5. It refuses REAL accounts and fails closed when heartbeat/trading permission disappears.
