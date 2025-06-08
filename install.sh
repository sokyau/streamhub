#!/bin/bash

# StreamHub - Script de Instalación Automática
set -e

echo "========================================"
echo "   StreamHub - Instalación Automática   "
echo "========================================"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[i]${NC} $1"
}

#if [[ $EUID -eq 0 ]]; then
 #  print_error "Este script no debe ejecutarse como root"
  # exit 1
#fi

print_info "Actualizando sistema..."
sudo apt-get update -y
sudo apt-get upgrade -y
print_status "Sistema actualizado"

print_info "Instalando dependencias del sistema..."
sudo apt-get install -y curl wget git build-essential libpcre3 libpcre3-dev libssl-dev zlib1g-dev ffmpeg
print_status "Dependencias del sistema instaladas"

print_info "Instalando Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
print_status "Node.js $(node -v) instalado"

print_info "Creando estructura de directorios..."
mkdir -p ~/streamhub/{uploads,db,nginx,logs,public}
cd ~/streamhub
print_status "Directorios creados"

print_info "Instalando NGINX con módulo RTMP..."
cd /tmp
wget http://nginx.org/download/nginx-1.24.0.tar.gz
tar -zxvf nginx-1.24.0.tar.gz
wget https://github.com/arut/nginx-rtmp-module/archive/master.zip
unzip master.zip

cd nginx-1.24.0
./configure --with-http_ssl_module --add-module=../nginx-rtmp-module-master
make
sudo make install
print_status "NGINX con RTMP instalado"

print_info "Configurando NGINX para RTMP..."
sudo tee /usr/local/nginx/conf/nginx.conf > /dev/null << 'NGINXEOF'
worker_processes auto;
events {
    worker_connections 1024;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4000;
        
        application live {
            live on;
            record off;
            allow publish 127.0.0.1;
            deny publish all;
            allow play all;
        }
    }
}

http {
    sendfile off;
    tcp_nopush on;
    directio 512;
    default_type application/octet-stream;

    server {
        listen 80;
        server_name localhost;

        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }
    }
}
NGINXEOF

print_status "NGINX configurado"

sudo tee /etc/systemd/system/nginx-rtmp.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=NGINX with RTMP module
After=network.target

[Service]
Type=forking
PIDFile=/usr/local/nginx/logs/nginx.pid
ExecStartPre=/usr/local/nginx/sbin/nginx -t
ExecStart=/usr/local/nginx/sbin/nginx
ExecReload=/bin/kill -s HUP $MAINPID
ExecStop=/bin/kill -s QUIT $MAINPID
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable nginx-rtmp
sudo systemctl start nginx-rtmp
print_status "Servicio NGINX creado y ejecutándose"

cd ~/streamhub

print_info "Instalando dependencias de Node.js..."
npm install
print_status "Dependencias instaladas"

print_info "Instalando PM2..."
sudo npm install -g pm2
print_status "PM2 instalado"

pm2 startup systemd -u $USER --hp $HOME
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME

print_info "Configurando firewall..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 1935/tcp
sudo ufw --force enable
print_status "Firewall configurado"

echo ""
echo "========================================"
echo -e "${GREEN}   ¡Instalación completada con éxito!   ${NC}"
echo "========================================"
echo ""
echo "La aplicación estará disponible en:"
echo "  http://$(hostname -I | awk '{print $1}')"
