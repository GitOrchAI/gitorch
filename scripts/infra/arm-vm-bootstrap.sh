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
install_firecracker() (
  echo "Verificando instalação do Firecracker (${FIRECRACKER_VERSION})...."
  if ! command -v firecracker >/dev/null 2>&1 || [ ! -f "${INSTALL_DIR}/firecracker" ]; then
    echo "Firecracker não encontrado localmente ou em ${INSTALL_DIR}. Iniciando download para aarch64..."
    
    FC_BINARY="firecracker-${FIRECRACKER_VERSION}-aarch64"
    JAILER_BINARY="jailer-${FIRECRACKER_VERSION}-aarch64"
    
    FC_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${FC_BINARY}"
    JAILER_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${JAILER_BINARY}"
    FC_SHA256_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/sha256sums.txt"
    
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "${TEMP_DIR}"' EXIT
    
    echo "Baixando hashes do Firecracker de: ${FC_SHA256_URL}"
    if ! curl -L -f -o "${TEMP_DIR}/sha256sums.txt" "${FC_SHA256_URL}"; then
      echo "Erro ao baixar o arquivo de checksum do Firecracker." >&2
      exit 1
    fi

    echo "Baixando firecracker de: ${FC_URL}"
    if ! curl -L -f -o "${TEMP_DIR}/${FC_BINARY}" "${FC_URL}"; then
      echo "Erro ao baixar o Firecracker a partir de ${FC_URL}." >&2
      exit 1
    fi
    
    echo "Baixando jailer de: ${JAILER_URL}"
    if ! curl -L -f -o "${TEMP_DIR}/${JAILER_BINARY}" "${JAILER_URL}"; then
      echo "Erro ao baixar o Jailer a partir de ${JAILER_URL}." >&2
      exit 1
    fi
    
    echo "Validando integridade com SHA256..."
    grep -E "(${FC_BINARY}|${JAILER_BINARY})$" "${TEMP_DIR}/sha256sums.txt" > "${TEMP_DIR}/filtered_sums.txt"
    
    (
      cd "${TEMP_DIR}"
      if ! sha256sum --check filtered_sums.txt; then
        echo "Erro: Validação de checksum SHA256 falhou para os binários do Firecracker." >&2
        exit 1
      fi
    )
    
    chmod +x "${TEMP_DIR}/${FC_BINARY}" "${TEMP_DIR}/${JAILER_BINARY}"
    
    mv "${TEMP_DIR}/${FC_BINARY}" "${INSTALL_DIR}/firecracker"
    mv "${TEMP_DIR}/${JAILER_BINARY}" "${INSTALL_DIR}/jailer"
    
    echo "Firecracker e Jailer instalados com sucesso em ${INSTALL_DIR}."
  else
    echo "Firecracker já está instalado localmente."
  fi
)

# Instalação do Containerd
install_containerd() (
  echo "Verificando instalação do containerd (${CONTAINERD_VERSION})..."
  if ! command -v containerd >/dev/null 2>&1 || [ ! -f "${INSTALL_DIR}/containerd" ]; then
    echo "containerd não encontrado localmente ou em ${INSTALL_DIR}. Iniciando download..."
    
    CONTAINERD_TAR="containerd-${CONTAINERD_VERSION}-linux-arm64.tar.gz"
    CONTAINERD_URL="https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/${CONTAINERD_TAR}"
    CONTAINERD_SHA256_URL="https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/${CONTAINERD_TAR}.sha256sum"
    
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "${TEMP_DIR}"' EXIT
    
    echo "Baixando checksum do containerd de: ${CONTAINERD_SHA256_URL}"
    if ! curl -L -f -o "${TEMP_DIR}/${CONTAINERD_TAR}.sha256sum" "${CONTAINERD_SHA256_URL}"; then
      echo "Erro ao baixar o checksum do containerd." >&2
      exit 1
    fi

    echo "Baixando containerd de: ${CONTAINERD_URL}"
    if ! curl -L -f -o "${TEMP_DIR}/${CONTAINERD_TAR}" "${CONTAINERD_URL}"; then
      echo "Erro ao baixar o containerd a partir de ${CONTAINERD_URL}." >&2
      exit 1
    fi
    
    echo "Validando integridade do containerd com SHA256..."
    (
      cd "${TEMP_DIR}"
      if ! sha256sum --check "${CONTAINERD_TAR}.sha256sum"; then
        echo "Erro: Validação de checksum SHA256 falhou para o containerd." >&2
        exit 1
      fi
    )
    
    echo "Descompactando containerd..."
    tar -xzf "${TEMP_DIR}/${CONTAINERD_TAR}" -C "${TEMP_DIR}"
    
    if [ -d "${TEMP_DIR}/bin" ]; then
      local file
      local has_files=false
      while IFS= read -r -d '' file; do
        has_files=true
        chmod 755 "$file"
        mv "$file" "${INSTALL_DIR}/"
      done < <(find "${TEMP_DIR}/bin" -maxdepth 1 -type f -print0)
      
      if [ "$has_files" = false ]; then
        echo "Erro: O diretório ${TEMP_DIR}/bin está vazio ou não contém arquivos regulares." >&2
        exit 1
      fi
    else
      echo "Estrutura do tarball do containerd inesperada, procurando binários..." >&2
      local file_exe
      local has_executables=false
      while IFS= read -r -d '' file_exe; do
        has_executables=true
        chmod 755 "$file_exe"
        mv "$file_exe" "${INSTALL_DIR}/"
      done < <(find "${TEMP_DIR}" -type f -executable -print0)
      
      if [ "$has_executables" = false ]; then
        echo "Erro: Nenhum executável encontrado no tarball do containerd." >&2
        exit 1
      fi
    fi
    
    echo "containerd instalado com sucesso em ${INSTALL_DIR}."
  else
    echo "containerd já está instalado localmente."
  fi
)

# Executar instalações
install_firecracker
install_containerd

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
