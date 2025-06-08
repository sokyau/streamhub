#!/bin/bash
set -e

# StreamHub – Instalar NGINX+RTMP con HTTP/2 y configurar SSL

DOMAIN="streamhub.sofe.site"
EMAIL="tu-email@ejemplo.com"  # Cámbialo luego
NGINX_VERSION="1.24.0"
PREFIX="/usr/local/nginx"
RTMP_MODULE_REPO="https://github.com/arut/nginx-rtmp-module.git"

# Colores
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
print_status(){ echo -e "${GREEN}[✓]${NC} $1"; }
print_error(){ echo -e "${RED}[✗]${NC} $1"; }
print_info(){ echo -e "${YELLOW}[i]${NC} $1"; }

# 0) Root?
if [[ $EUID -ne 0 ]]; then
  print_error "Ejecuta como root"
  exit 1
fi

print_info "1) Instalando dependencias de compilación"
apt-get update
apt-get install -y \
    build-essential libpcre3 libpcre3-dev zlib1g-dev libssl-dev git \
    certbot python3-certbot-nginx software-properties-common
print_status "Dependencias instaladas"

print_info "2) Deteniendo servicio nginx-rtmp (si existe)"
systemctl stop nginx-rtmp || true

print_info "3) Descargando NGINX $NGINX_VERSION y módulo RTMP"
cd /usr/local/src
wget http://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz
tar zxvf nginx-${NGINX_VERSION}.tar.gz
git clone ${RTMP_MODULE_REPO}
print_status "Descargas completadas"

print_info "4) Compilando NGINX con HTTP/2 y RTMP"
cd nginx-${NGINX_VERSION}
./configure \
  --prefix=${PREFIX} \
  --with-http_ssl_module \
  --with-http_v2_module \
  --add-module=../nginx-rtmp-module
make
make install
print_status "NGINX compilado e instalado en ${PREFIX}"

# 5) Hacer backup de tu conf y sobreescribir con la tuya
print_info "5) Backup y despliegue de nginx.conf"
cp ${PREFIX}/conf/nginx.conf ${PREFIX}/conf/nginx.conf.backup
cat > ${PREFIX}/conf/nginx.conf << 'NGINX_CONFIG'
# aquí pega tu bloque completo (rtmp + http + SSL)
# [...]
NGINX_CONFIG
print_status "nginx.conf actualizado"

# 6) Iniciar NGINX y validar configuración
print_info "6) Validando y arrancando NGINX"
${PREFIX}/sbin/nginx -t
systemctl daemon-reload
systemctl enable nginx-rtmp
systemctl start nginx-rtmp
print_status "NGINX arrancado"

# 7) Solicitar y desplegar certificado SSL
print_info "7) Obteniendo certificado Let's Encrypt"
certbot certonly --standalone -d $DOMAIN \
  --email $EMAIL --agree-tos --non-interactive
sed -i "s|# ssl_certificate|ssl_certificate|g" ${PREFIX}/conf/nginx.conf
sed -i "s|# ssl_certificate_key|ssl_certificate_key|g" ${PREFIX}/conf/nginx.conf

print_status "Certificado instalado en /etc/letsencrypt"

# 8) Reiniciar NGINX con SSL
print_info "8) Reiniciando NGINX con SSL"
systemctl restart nginx-rtmp
print_status "NGINX reiniciado"

# 9) Firewall y renovación
ufw allow 80/tcp && ufw allow 443/tcp && ufw reload
print_status "Firewall configurado"

cat > /etc/systemd/system/certbot-renewal.service << 'EOF'
[Unit]
Description=Renovación Certbot
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --pre-hook "systemctl stop nginx-rtmp" --post-hook "systemctl start nginx-rtmp"
EOF

cat > /etc/systemd/system/certbot-renewal.timer << 'EOF'
[Unit]
Description=Renovación bisemanal Let's Encrypt

[Timer]
OnCalendar=0/12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable certbot-renewal.timer
systemctl start certbot-renewal.timer
print_status "Renovación automática configurada"

echo -e "\n${GREEN}¡Listo!${NC} Ahora NGINX + RTMP está compilado con HTTP/2 y SSL configurado."

