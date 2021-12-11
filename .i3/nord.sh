#!/bin/bash

str="$(nordvpn status | sed -n '3p;5p' | sed 's/:/\n/g' | sed -n '2p;4p' | sed -e 's/^[[:space:]]*//')"
[ -z "$str" ] && echo "Disconnected" && exit
IFS=$'\n' read -d "\034" -r -a array <<<"${str}\034"
country="${array[0]}"
ip="${array[1]}"
echo "$country ($ip)"
