#!/bin/bash
set -euo pipefail

# Script de bootstrap para provisionamento de infraestrutura ARM com Firecracker e Containerd.
# Este script deve ser executado com privilégios de root (sudo).

# Configurações de versões
FIRECRACKER_VERSION=${FIRECRACKER_VERSION:-"v1.7.0"}
CONTAINERD_VERSION=${CONTAINERD_VERSION:-"1.7.13"}
INSTALL_DIR="/usr/local/bin"
WORKSPACE_DIR="/var/lib/gitorch/workspaces"

echo "=== Iniciando o Provisionamento de Infra ARM (Firecracker) ==="

# 1. Verificar privilégios root (sudo/root)
if [ "$EUID" -ne 0 ]; then
  echo "Erro: Este script precisa ser executado como root ou com sudo." >&2
  exit 1
fi

# 2. Verificar se KVM está habilitado/disponível no sistema ARM (verificar se /dev/kvm existe)
echo "Verificando se KVM está disponível..."
if [ ! -e "/dev/kvm" ]; then
  echo "Erro: KVM não está habilitado ou /dev/kvm não existe no sistema." >&2
  echo "Certifique-se de que a virtualização está ativa na BIOS/firmware e o módulo KVM está carregado." >&2
  exit 1
fi
echo "KVM está disponível."

# 3. Baixar os binários do Firecracker (versão adequada para aarch64/ARM64) e containerd (se não existirem localmente)
# Instalação do Firecracker
echo "Verificando instalação do Firecracker (${FIRECRACKER_VERSION})...."
if ! command -v firecracker >/dev/null 2>&1 || [ ! -f "${INSTALL_DIR}/firecracker" ]; then
  echo "Firecracker não encontrado localmente ou em ${INSTALL_DIR}. Iniciando download para aarch64..."
  
  FC_BINARY="firecracker-${FIRECRACKER_VERSION}-aarch64"
  JAILER_BINARY="jailer-${FIRECRACKER_VERSION}-aarch64"
  
  FC_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${FC_BINARY}"
  JAILER_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${JAILER_BINARY}"
  
  TEMP_DIR=$(mktemp -d)
  
  echo "Baixando firecracker de: ${FC_URL}"
  if ! curl -L -f -o "${TEMP_DIR}/firecracker" "${FC_URL}"; then
    echo "Erro ao baixar o Firecracker a partir de ${FC_URL}." >&2
    rm -rf "${TEMP_DIR}"
    exit 1
  fi
  
  echo "Baixando jailer de: ${JAILER_URL}"
  if ! curl -L -f -o "${TEMP_DIR}/jailer" "${JAILER_URL}"; then
    echo "Erro ao baixar o Jailer a partir de ${JAILER_URL}." >&2
    rm -rf "${TEMP_DIR}"
    exit 1
  fi
  
  chmod +x "${TEMP_DIR}/firecracker" "${TEMP_DIR}/jailer"
  
  mv "${TEMP_DIR}/firecracker" "${INSTALL_DIR}/firecracker"
  mv "${TEMP_DIR}/jailer" "${INSTALL_DIR}/jailer"
  
  rm -rf "${TEMP_DIR}"
  echo "Firecracker e Jailer instalados com sucesso em ${INSTALL_DIR}."
else
  echo "Firecracker já está instalado localmente."
fi

# Instalação do Containerd
echo "Verificando instalação do containerd (${CONTAINERD_VERSION})..."
if ! command -v containerd >/dev/null 2>&1 || [ ! -f "${INSTALL_DIR}/containerd" ]; then
  echo "containerd não encontrado localmente ou em ${INSTALL_DIR}. Iniciando download..."
  
  CONTAINERD_TAR="containerd-${CONTAINERD_VERSION}-linux-arm64.tar.gz"
  CONTAINERD_URL="https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/${CONTAINERD_TAR}"
  
  TEMP_DIR=$(mktemp -d)
  
  echo "Baixando containerd de: ${CONTAINERD_URL}"
  if ! curl -L -f -o "${TEMP_DIR}/${CONTAINERD_TAR}" "${CONTAINERD_URL}"; then
    echo "Erro ao baixar o containerd a partir de ${CONTAINERD_URL}." >&2
    rm -rf "${TEMP_DIR}"
    exit 1
  fi
  
  echo "Descompactando containerd..."
  tar -xzf "${TEMP_DIR}/${CONTAINERD_TAR}" -C "${TEMP_DIR}"
  
  # Mover os binários de bin/ do tar para o diretório de instalação
  if [ -d "${TEMP_DIR}/bin" ]; then
    chmod +x "${TEMP_DIR}"/bin/*
    mv "${TEMP_DIR}"/bin/* "${INSTALL_DIR}/"
  else
    echo "Estrutura do tarball do containerd inesperada, procurando binários..." >&2
    find "${TEMP_DIR}" -type f -executable -exec mv {} "${INSTALL_DIR}/" \;
  fi
  
  rm -rf "${TEMP_DIR}"
  echo "containerd instalado com sucesso em ${INSTALL_DIR}."
else
  echo "containerd já está instalado localmente."
fi

# 4. Adicionar lógica para criar o diretório base de discos persistentes por tenant (/var/lib/gitorch/workspaces)
echo "Configurando diretório base para workspaces persistentes: ${WORKSPACE_DIR}..."
if [ ! -d "${WORKSPACE_DIR}" ]; then
  mkdir -p "${WORKSPACE_DIR}"
  chmod 755 "${WORKSPACE_DIR}"
  echo "Diretório ${WORKSPACE_DIR} criado com sucesso."
else
  echo "Diretório ${WORKSPACE_DIR} já existe."
fi

echo "=== Provisionamento finalizado com sucesso! ==="
