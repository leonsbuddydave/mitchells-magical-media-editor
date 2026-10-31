#!/bin/sh
case "$1" in
  "Butternut, WI") echo '{"matches":[{"name":"Butternut","address":"Butternut, WI, United States","latitude":46.0131484,"longitude":-90.4966458,"timeZone":"America/Chicago"}]}' ;;
  "Walt Disney World") echo '{"matches":[{"name":"Walt Disney World Resort","address":"N World Dr, Orlando, FL 32830, United States","latitude":28.3802438,"longitude":-81.5611765,"timeZone":"America/New_York"}]}' ;;
  "Grandma's house") echo '{"matches":[{"name":"Grandma'"'"'s house","address":"38422 Hood St, Sandy, OR 97055, United States","latitude":45.3985294,"longitude":-122.2682426,"timeZone":"America/Los_Angeles"}]}' ;;
  *) echo '{"matches":[]}' ;;
esac
