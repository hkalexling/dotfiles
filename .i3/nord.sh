#!/bin/bash

str="$(nordvpn status | grep -E 'Status|Country|IP' | sed 's/:/\n/g' | sed -n '2p;4p;6p' | sed -e 's/^[[:space:]]*//')"
IFS=$'\n' read -d "\034" -r -a array <<<"${str}\034"
status="${array[0]}"
ip="${array[1]}"
country="${array[2]}"
[ "$str" == "Disconnected" ] && echo "Disconnected" && exit
echo "$country ($ip)"
