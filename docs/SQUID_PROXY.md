# Squid Proxy Setup & Configuration Guide

This document captures the setup process, configuration files, and operational commands for running an authenticated Squid HTTP/HTTPS forward proxy on AWS Lightsail or EC2 for use with `yt-diff` and external services.

---

## 1. Overview & Architecture

Certain services (such as X.com / Twitter media endpoints) require or benefit from egress via a dedicated proxy IP. A minimal, authenticated Squid proxy instance on AWS Lightsail or EC2 satisfies this requirement.

- **Default Port**: `3128` (TCP)
- **Authentication**: HTTP Basic Auth (`ncsa_auth` against htpasswd file)
- **Supported Platforms**: Ubuntu 22.04 LTS / 24.04 LTS (x86_64 or ARM64)
- **Client format**: `http://<username>:<password>@<public-ip>:3128`

---

## 2. Firewall / Security Group Configuration

Before or immediately after installation, ensure port `3128` is reachable:
1. In the **AWS Lightsail Console** (or EC2 Security Group):
   - Navigate to **Networking** → **IPv4 Firewall**.
   - Add rule:
     - **Protocol**: `TCP`
     - **Port**: `3128`
     - **Source**: Restrict to your home/server IP (e.g. `<your-ip>/32`) for security, or `0.0.0.0/0` if egress IPs fluctuate (Squid's `basic_ncsa_auth` blocks unauthenticated requests with `TCP_DENIED/407`).
2. If `ufw` is active on the server:
   ```bash
   sudo ufw allow 3128/tcp
   ```

---

## 3. Automated Setup Script

The automated installer is located in the repository at [`scripts/proxy.sh`](file:///home/sagnik/Projects/docker-composes/yt-diff/scripts/proxy.sh).

To run it on a fresh Ubuntu instance:

```bash
# Upload or curl the script, make executable, and execute:
chmod +x scripts/proxy.sh
./scripts/proxy.sh
```

The script automatically:
1. Updates package repositories and installs `squid` and `apache2-utils`.
2. Generates a secure random 16-character password for user `ytdiff`.
3. Populates `/etc/squid/passwords` using `htpasswd`.
4. Backs up `/etc/squid/squid.conf` to `/etc/squid/squid.conf.bak`.
5. Writes the authenticated Squid configuration to `/etc/squid/squid.conf`.
6. Enables and restarts the `squid` systemd service.
7. Prints the ready-to-use proxy string formatted for `yt-diff`.

---

## 4. Manual Setup & Configuration

If deploying manually or verifying an existing installation:

### Step 1: Install Packages
```bash
sudo apt-get update
sudo apt-get install -y squid apache2-utils curl
```

### Step 2: Configure Authentication File
```bash
# Replace <username> and <password> with your desired credentials:
sudo htpasswd -b -c /etc/squid/passwords ytdiff "<password>"
sudo chmod 644 /etc/squid/passwords
```

To add additional users or update an existing password:
```bash
sudo htpasswd -b /etc/squid/passwords <username> "<new-password>"
sudo systemctl reload squid
```

### Step 3: Write Squid Configuration
Write the following minimal configuration to `/etc/squid/squid.conf`:

```apache
# Define the authentication method (basic htpasswd)
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwords
auth_param basic realm EC2 Proxy Server
auth_param basic credentialsttl 2 hours

# Define the ACL for authenticated users
acl authenticated proxy_auth REQUIRED

# Allow access only to authenticated users, deny everything else
http_access allow authenticated
http_access deny all

# Define the port the proxy listens on
http_port 3128

# Hide client IP for anonymity (strips client IP and Via headers)
forwarded_for delete
request_header_access Via deny all
```

### Step 4: Restart & Enable Service
```bash
sudo systemctl restart squid
sudo systemctl enable squid
sudo systemctl status squid
```

---

## 5. Client Wiring in `yt-diff`

In `yt-diff`, the proxy connection string is delivered via Docker secret:

1. Write the proxy string to `secrets/proxy_string.txt`:
   ```bash
   printf %s 'http://ytdiff:<password>@<server-ip>:3128' > secrets/proxy_string.txt
   ```
2. In [`docker-compose.yml`](file:///home/sagnik/Projects/docker-composes/yt-diff/docker-compose.yml):
   ```yaml
   secrets:
     proxy_string:
       file: secrets/proxy_string.txt
   services:
     yt-diff:
       secrets:
         - proxy_string
       environment:
         - PROXY_STRING_FILE=/run/secrets/proxy_string
   ```
3. Restart `yt-diff` to mount the updated secret:
   ```bash
   docker compose restart yt-diff
   ```

*Note: In `yt-diff`, proxy routing is selectively applied to domains requiring it (e.g. `x.com` and `iwara.tv`) inside `buildSiteArgs` in `index.ts`.*

---

## 6. Verification & Troubleshooting

### Test Proxy Connectivity
From your local machine or server, verify the proxy works:
```bash
curl -x http://<user>:<password>@<server-ip>:3128 https://ipinfo.io
```
Expected output: JSON containing the proxy server's public IP and location.

### Inspect Access Logs
Squid logs every request to `/var/log/squid/access.log`:
```bash
sudo tail -f /var/log/squid/access.log
```
Common log statuses:
- `TCP_TUNNEL/200` — Successful CONNECT tunnel for HTTPS (traffic passing).
- `TCP_DENIED/407` — Missing or invalid authentication (normal for bots probing port 3128).

### Test yt-dlp through Proxy
```bash
yt-dlp --proxy http://<user>:<password>@<server-ip>:3128 -F https://www.youtube.com/watch?v=dQw4w9WgXcQ
```
