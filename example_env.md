# How to get the data?

1. Goto <https://account.protonvpn.com/downloads> and download the configuration of the server that suits your loaction.
2. For OPENVPN configuration find remote ip port
3. Use <https://www.iplocation.net/ip-lookup> to find the Region,City
4. Server hostname is the name of the configuration file.
5. For WIREGUARD the configuration of Country,Region and City are same just download the configuration and get the needed data from the file.

## EXAMPLE

    #USER
    USERNAME_VPN=USER
    PASSWORD_VPN=PASS

    #PROVIDER
    SERVICE_PROVIDER_VPN=protonvpn
    FREE=on

    # OPENVPN
    #JAPAN
    SERVER_COUNTRIES_PREFERRED=Japan
    SERVER_REGIONS_PREFERRED=Tokyo
    SERVER_CITIES_PREFERRED=Tokyo
    SERVER_HOSTNAMES_PREFERRED=jp-free-08.protonvpn.net

    #NETHERLANDS
    SERVER_COUNTRIES=Netherlands
    SERVER_REGIONS=Zuid-Holland
    SERVER_CITIES=Naaldwijk
    SERVER_HOSTNAMES=nl-free-104.protonvpn.net

    # WIREGUARD
    #JAPAN
    WIREGUARD_PRIVATE_KEY_PREFERRED='GET YOUR OWN PRIVATE KEY'
    WIREGUARD_ADDRESSES_PREFERRED='REDACTED'

    #NETHERLANDS
    WIREGUARD_PRIVATE_KEY='GET YOUR OWN PRIVATE KEY'
    WIREGUARD_ADDRESSES='REDACTED'

    # CONTAINER OPTIONS
    TZ_PREFERRED=Asia/Kolkata

    # DB CONFIGURATION
    DB_PASSWORD='REDACTED'
    DB_USERNAME=yt-diff
    DB_NAME=vid-list
