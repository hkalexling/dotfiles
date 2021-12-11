#! /bin/bash

sudo nordvpn set killswitch off
# systemctl restart would sometimes fail. no idea why
echo "stopping"
sudo systemctl stop nordvpnd
echo "waiting for 5s"
sleep 5
echo "starting"
sudo systemctl start nordvpnd # This should automatically reconnect, so we don't need to explicitly connect
sudo nordvpn set killswitch on
