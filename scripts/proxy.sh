#!/bin/bash
set -e

# Configuration
PROXY_PORT=3128
PROXY_USER="ytdiff"
# Generate a secure random 16-character password
PROXY_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 16 | head -n 1)

echo "Updating system and installing Squid proxy..."
sudo apt-get update
sudo apt-get install -y squid apache2-utils curl

echo "Setting up proxy authentication..."
# Create the password file with the generated credentials
sudo htpasswd -b -c /etc/squid/passwords "$PROXY_USER" "$PROXY_PASS"

echo "Configuring Squid..."
# Backup the original squid config just in case
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.bak

# Write a minimal, secure authenticated squid configuration
sudo bash -c "cat > /etc/squid/squid.conf << 'EOF'
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

# Hide client IP for anonymity (Optional but good for privacy)
forwarded_for delete
request_header_access Via deny all
EOF"

echo "Restarting Squid service..."
sudo systemctl restart squid
sudo systemctl enable squid

# Fetch the public IP to display the proxy string
PUBLIC_IP=$(curl -s ifconfig.me)

echo "============================================================"
echo "Proxy Server Successfully Installed and Running!"
echo "============================================================"
echo "Your Proxy String for yt-diff:"
echo "http://${PROXY_USER}:${PROXY_PASS}@${PUBLIC_IP}:${PROXY_PORT}"
echo ""
echo "CRITICAL NEXT STEP:"
echo "Make sure to open TCP Port $PROXY_PORT in your AWS EC2 Security Group for inbound traffic."
echo "============================================================"
# Run this to get the proxy string later
# cat /var/log/cloud-init-output.log | grep "http://ytdiff:"
# or
# sudo htpasswd -b -c /etc/squid/passwords ytdiff YOUR_PASSWORD
# sudo systemctl reload squid