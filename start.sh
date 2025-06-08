#!/bin/bash
cd ~/streamhub
pm2 start ecosystem.config.js
pm2 save
echo "StreamHub iniciado. Accede a http://$(hostname -I | awk '{print $1}')"
