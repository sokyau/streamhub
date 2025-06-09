#!/bin/bash
set -e

DOMAIN="streamhub.sofe.site"
EMAIL="admin@sofe.site"
NGINX_VERSION="1.24.0"
RTMP_MODULE_URL="https://github.com/arut/nginx-rtmp-module/archive/master.zip"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() { echo -e "${GREEN}[✓]${NC} $1"; }
print_error() { echo -e "${RED}[✗]${NC} $1"; }
print_info() { echo -e "${YELLOW}[i]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
   print_error "Este script debe ejecutarse como root"
   exit 1
fi

print_info "Deteniendo NGINX actual..."
systemctl stop nginx-rtmp || true

print_info "Instalando dependencias..."
apt-get update
apt-get install -y build-essential libpcre3 libpcre3-dev libssl-dev \
                   zlib1g-dev unzip wget certbot python3-certbot-nginx

print_info "Descargando NGINX ${NGINX_VERSION} y módulo RTMP..."
cd /tmp
rm -rf nginx-${NGINX_VERSION}* nginx-rtmp-module-master*

wget http://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz
tar -zxvf nginx-${NGINX_VERSION}.tar.gz

wget ${RTMP_MODULE_URL} -O nginx-rtmp-module.zip
unzip nginx-rtmp-module.zip

print_info "Compilando NGINX con HTTP/2 y RTMP..."
cd nginx-${NGINX_VERSION}
./configure \
    --prefix=/usr/local/nginx \
    --with-http_ssl_module \
    --with-http_v2_module \
    --with-http_realip_module \
    --with-http_addition_module \
    --with-http_sub_module \
    --with-http_dav_module \
    --with-http_flv_module \
    --with-http_mp4_module \
    --with-http_gunzip_module \
    --with-http_gzip_static_module \
    --with-http_random_index_module \
    --with-http_secure_link_module \
    --with-http_stub_status_module \
    --with-http_auth_request_module \
    --with-threads \
    --with-stream \
    --with-stream_ssl_module \
    --with-http_slice_module \
    --with-file-aio \
    --add-module=../nginx-rtmp-module-master

make -j$(nproc)
make install

print_status "NGINX compilado e instalado"

print_info "Creando servicio systemd..."
cat > /etc/systemd/system/nginx-rtmp.service << 'EOF'
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
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nginx-rtmp

print_info "Respaldando configuración actual..."
cp /usr/local/nginx/conf/nginx.conf /usr/local/nginx/conf/nginx.conf.backup.$(date +%Y%m%d_%H%M%S)

print_info "Aplicando nueva configuración con HTTP/2..."
cat > /usr/local/nginx/conf/nginx.conf << 'NGINX_CONF'
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
    include       mime.types;
    default_type  application/octet-stream;
    
    sendfile off;
    tcp_nopush on;
    directio 512;
    
    # Configuración para archivos grandes
    client_max_body_size 0;
    client_body_timeout 3600;
    client_header_timeout 3600;
    keepalive_timeout 3600;
    send_timeout 3600;
    proxy_connect_timeout 3600;
    proxy_send_timeout 3600;
    proxy_read_timeout 3600;
    
    # Buffer sizes
    client_body_buffer_size 128M;
    client_header_buffer_size 64k;
    large_client_header_buffers 4 64k;
    
    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    server {
        listen 80;
        listen 443 ssl http2;
        server_name streamhub.sofe.site;

        # SSL será configurado por certbot
        # ssl_certificate /etc/letsencrypt/live/streamhub.sofe.site/fullchain.pem;
        # ssl_certificate_key /etc/letsencrypt/live/streamhub.sofe.site/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # Seguridad
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
            
            # Timeouts largos
            proxy_connect_timeout 3600;
            proxy_send_timeout 3600;
            proxy_read_timeout 3600;
            
            # Buffer sizes
            proxy_buffer_size 128k;
            proxy_buffers 4 256k;
            proxy_busy_buffers_size 256k;
        }

        # WebSocket
        location /ws {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
NGINX_CONF

print_info "Verificando configuración..."
/usr/local/nginx/sbin/nginx -t

print_info "Iniciando NGINX..."
systemctl start nginx-rtmp

print_info "Obteniendo certificado SSL..."
certbot certonly --webroot -w /usr/local/nginx/html -d ${DOMAIN} --non-interactive --agree-tos --email ${EMAIL} || {
    print_error "Error al obtener certificado. Intentando con standalone..."
    systemctl stop nginx-rtmp
    certbot certonly --standalone -d ${DOMAIN} --non-interactive --agree-tos --email ${EMAIL}
    systemctl start nginx-rtmp
}

print_info "Actualizando configuración con SSL..."
sed -i "s|# ssl_certificate|ssl_certificate|g" /usr/local/nginx/conf/nginx.conf
sed -i "s|# ssl_certificate_key|ssl_certificate_key|g" /usr/local/nginx/conf/nginx.conf

print_info "Recargando NGINX con SSL..."
systemctl reload nginx-rtmp

print_info "Configurando renovación automática..."
cat > /etc/systemd/system/certbot-renewal.service << 'EOF'
[Unit]
Description=Certbot Renewal
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx-rtmp"
EOF

cat > /etc/systemd/system/certbot-renewal.timer << 'EOF'
[Unit]
Description=Run certbot twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable certbot-renewal.timer
systemctl start certbot-renewal.timer

print_info "Configurando firewall..."
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 1935/tcp
ufw allow 3000/tcp
ufw --force enable

print_status "¡Instalación completada!"
print_info "NGINX con HTTP/2 y RTMP instalado"
print_info "SSL configurado para ${DOMAIN}"
print_info "Renovación automática activada"

nginx_version=$(/usr/local/nginx/sbin/nginx -v 2>&1)
print_info "Versión instalada: ${nginx_version}"

/usr/local/nginx/sbin/nginx -V 2>&1 | grep -q "http_v2_module" && \
    print_status "HTTP/2 module instalado correctamente" || \
    print_error "HTTP/2 module NO encontrado"
