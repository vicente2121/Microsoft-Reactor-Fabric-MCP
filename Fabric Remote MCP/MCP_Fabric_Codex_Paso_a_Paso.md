# Como se conecto el MCP de Microsoft Fabric a Codex en VS Code

Documentacion ajustada a la configuracion real actual del equipo:

- Usuario Windows: `C:\Users\vicen`
- Configuracion de Codex: `C:\Users\vicen\.codex\config.toml`
- Proxy local: `C:\Users\vicen\fabric-mcp-proxy`
- MCP activo usado por Codex: `fabric_remote_core`
- MCP remoto real de Microsoft Fabric: `https://api.fabric.microsoft.com/v1/mcp/core`

---

## 1. Objetivo

El objetivo es usar desde Codex el servidor MCP remoto de Microsoft Fabric:

```text
https://api.fabric.microsoft.com/v1/mcp/core
```

Con esto Codex puede ejecutar herramientas de Fabric, por ejemplo:

- listar workspaces
- consultar detalles de un workspace
- listar elementos dentro de un workspace
- buscar elementos en el catalogo de OneLake
- listar carpetas

Un ejemplo real usado fue:

```text
mcp__fabric_remote_core.list_workspaces
```

Ese comando devolvio los espacios de trabajo de Fabric a los que la cuenta tiene acceso.

---

## 2. Por que no se conecta Codex directamente al MCP remoto

El servidor remoto de Fabric necesita autenticacion de Microsoft Entra ID.
Es decir, no basta con llamar a la URL del MCP:

```toml
[mcp_servers.fabric]
url = "https://api.fabric.microsoft.com/v1/mcp/core"
```

Para que funcione, cada llamada tiene que llevar un token valido:

```http
Authorization: Bearer <token>
```

El problema practico es que Codex, en esta configuracion, no esta gestionando directamente el flujo de autenticacion OAuth contra el MCP remoto de Fabric.

Por eso se usa un proxy local: Codex se conecta al proxy como servidor MCP local, y el proxy se encarga de obtener el token y reenviar las llamadas a Fabric.

---

## 3. Arquitectura final

El flujo real queda asi:

```text
Codex en VS Code
  |
  | MCP local por stdio
  v
Proxy Node local
C:\Users\vicen\fabric-mcp-proxy\index.js
  |
  | HTTP + Authorization Bearer
  v
MCP remoto de Microsoft Fabric
https://api.fabric.microsoft.com/v1/mcp/core
```

Codex no llama directamente a Fabric.
Codex ejecuta un comando local:

```powershell
node C:\Users\vicen\fabric-mcp-proxy\index.js
```

Ese script local se conecta al endpoint remoto real de Fabric.

---

## 4. Archivos del proxy

El proxy esta instalado en:

```text
C:\Users\vicen\fabric-mcp-proxy
```

Contenido principal:

| Archivo | Funcion |
|---|---|
| `index.js` | Script principal. Expone un MCP local por `stdio`, obtiene token con Azure CLI y reenvia las llamadas al MCP remoto de Fabric. |
| `package.json` | Define el proyecto Node y la dependencia `@modelcontextprotocol/sdk`. |
| `package-lock.json` | Fija versiones exactas instaladas por `npm install`. |
| `README.md` | Instrucciones breves del proxy. |
| `node_modules/` | Dependencias instaladas localmente. |

El `package.json` actual indica:

```json
{
  "name": "fabric-mcp-proxy",
  "version": "1.0.0",
  "description": "Local stdio MCP proxy for Microsoft Fabric remote Core MCP.",
  "type": "module",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.18.2"
  },
  "engines": {
    "node": ">=18"
  }
}
```

---

## 5. Como obtiene el token

Esta version del proxy no hace un flujo OAuth propio con navegador, `redirect_uri`, `refresh_token` ni archivo `token.json`.

La autenticacion se delega en Azure CLI.

El proxy ejecuta localmente:

```powershell
az account get-access-token --resource https://api.fabric.microsoft.com
```

Ese comando devuelve un token de acceso para Microsoft Fabric.

Luego el proxy llama al MCP remoto de Fabric anadiendo:

```http
Authorization: Bearer <token>
```

Esto tiene una ventaja importante: no hay que guardar un token fijo en `config.toml`.
La sesion y la renovacion de credenciales quedan gestionadas por Azure CLI.

---

## 6. Requisitos previos

Para que el proxy funcione, el equipo necesita:

1. Node.js instalado, version 18 o superior.
2. Azure CLI instalado.
3. Sesion iniciada en Azure CLI con una cuenta que tenga acceso a Microsoft Fabric.
4. Dependencias Node instaladas en `C:\Users\vicen\fabric-mcp-proxy`.

El login se hace con:

```powershell
az login
```

Para comprobar que Azure CLI puede obtener token para Fabric:

```powershell
az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv
```

Si devuelve texto largo, Azure CLI esta entregando token correctamente.

Tambien se puede probar el proxy sin mostrar el token:

```powershell
cd C:\Users\vicen\fabric-mcp-proxy
node index.js --token-test
```

El resultado esperado es algo parecido a:

```json
{"tokenLength":1234}
```

No muestra el token, solo su longitud.

---

## 7. Configuracion final en Codex

La configuracion activa esta en:

```text
C:\Users\vicen\.codex\config.toml
```

El bloque real activo es:

```toml
[mcp_servers.fabric_remote_core]
command = "node"
args = ['C:\Users\vicen\fabric-mcp-proxy\index.js']
cwd = 'C:\Users\vicen\fabric-mcp-proxy'
env_vars = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PSModulePath",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERPROFILE"
]
enabled = true
startup_timeout_sec = 30.0
tool_timeout_sec = 120.0
```

Puntos importantes:

- `command = "node"`: Codex arranca Node.
- `args = [...]`: Node ejecuta el script local del proxy.
- `cwd = ...`: el proceso se ejecuta desde la carpeta del proxy.
- `env_vars = [...]`: Codex pasa variables de entorno de Windows al proceso para que encuentre rutas, perfil de usuario, Azure CLI, temporales, etc.
- `enabled = true`: este es el MCP activo.
- `startup_timeout_sec = 30.0`: Codex espera hasta 30 segundos a que arranque.
- `tool_timeout_sec = 120.0`: cada herramienta MCP puede tardar hasta 120 segundos.

---

## 8. Otros MCP relacionados que existen pero no estan activos

En el mismo `config.toml` hay otros servidores relacionados con Fabric, pero estan desactivados:

```toml
[mcp_servers.fabric_local_vscode_full]
command = 'C:\Users\vicen\.vscode\extensions\fabric.vscode-fabric-mcp-server-1.2.0-win32-x64\server\fabmcp.exe'
args = ["server", "start"]
startup_timeout_sec = 30
enabled = false
```

```toml
[mcp_servers.fabric_http_core_proxy]
url = "http://127.0.0.1:3000"
enabled = false
```

Por tanto, el que se uso para listar workspaces no fue ninguno de esos.
El usado fue:

```text
fabric_remote_core
```

---

## 9. Que hace internamente `index.js`

El script `index.js` hace cuatro cosas principales.

Primero define la URL remota de Fabric:

```js
const FABRIC_MCP_URL =
  process.env.FABRIC_MCP_URL ?? "https://api.fabric.microsoft.com/v1/mcp/core";
```

Tambien define el recurso para el token:

```js
const FABRIC_RESOURCE =
  process.env.FABRIC_RESOURCE ?? "https://api.fabric.microsoft.com";
```

Despues obtiene un token usando Azure CLI:

```powershell
az account get-access-token --resource https://api.fabric.microsoft.com
```

Luego crea un transporte HTTP hacia el MCP remoto:

```js
remoteTransport = new StreamableHTTPClientTransport(new URL(FABRIC_MCP_URL), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`
    }
  }
});
```

Finalmente expone un servidor MCP local por `stdio`:

```js
await server.connect(new StdioServerTransport());
```

Eso permite que Codex lo trate como un MCP local normal.

---

## 10. Cache y renovacion del token

El proxy guarda el token solamente en memoria del proceso.

No se usa un archivo local tipo:

```text
C:\Users\vicen\.fabric-mcp-proxy\token.json
```

En esta version no aplica.

El comportamiento real es:

- El proxy pide token a Azure CLI.
- Lo mantiene cacheado en memoria durante 45 minutos.
- Si pasan mas de 45 minutos, vuelve a pedir otro token a Azure CLI.
- Si Fabric devuelve `401 Unauthorized`, limpia el cache, pide un token nuevo y reintenta.

La sesion persistente depende de Azure CLI, no del proxy.

Si Azure CLI pierde la sesion o cambia la cuenta, hay que volver a ejecutar:

```powershell
az login
```

---

## 11. Instalacion inicial paso a paso

Si hubiera que reconstruirlo desde cero, los pasos serian estos.

### Paso 1: crear carpeta

```powershell
mkdir C:\Users\vicen\fabric-mcp-proxy
cd C:\Users\vicen\fabric-mcp-proxy
```

### Paso 2: crear el proyecto Node

```powershell
npm init -y
```

### Paso 3: instalar el SDK MCP

```powershell
npm install @modelcontextprotocol/sdk
```

### Paso 4: dejar el proyecto como modulo ES

En `package.json`, asegurarse de que existe:

```json
"type": "module"
```

Y que el script principal es:

```json
"main": "index.js"
```

### Paso 5: crear `index.js`

El archivo `index.js` debe:

- importar el SDK MCP
- obtener token con Azure CLI
- crear un cliente MCP HTTP hacia Fabric
- crear un servidor MCP local por `stdio`
- reenviar tools, resources y prompts al servidor remoto

En la instalacion actual, ese archivo ya existe en:

```text
C:\Users\vicen\fabric-mcp-proxy\index.js
```

### Paso 6: iniciar sesion en Azure CLI

```powershell
az login
```

### Paso 7: probar token

```powershell
cd C:\Users\vicen\fabric-mcp-proxy
node index.js --token-test
```

### Paso 8: configurar Codex

Editar:

```text
C:\Users\vicen\.codex\config.toml
```

Agregar o dejar activo:

```toml
[mcp_servers.fabric_remote_core]
command = "node"
args = ['C:\Users\vicen\fabric-mcp-proxy\index.js']
cwd = 'C:\Users\vicen\fabric-mcp-proxy'
enabled = true
startup_timeout_sec = 30.0
tool_timeout_sec = 120.0
```

En la configuracion real tambien se incluyen `env_vars` para que el proceso herede variables basicas de Windows.

### Paso 9: recargar Codex o VS Code

Despues de cambiar `config.toml`, recargar la ventana:

```text
Developer: Reload Window
```

O apagar y encender el MCP desde la configuracion de MCP servers.

### Paso 10: verificar desde Codex

Pedir en el chat:

```text
lista mis workspaces de Fabric usando el MCP
```

Codex debe usar:

```text
mcp__fabric_remote_core.list_workspaces
```

Si responde con los workspaces reales, la conexion funciona de punta a punta.

---

## 12. Verificacion realizada

La verificacion real hecha en esta sesion fue:

1. Codex cargo el MCP `fabric_remote_core`.
2. Se ejecuto la herramienta:

```text
mcp__fabric_remote_core.list_workspaces
```

3. Fabric devolvio workspaces reales, entre ellos:

```text
My workspace
Pruebas
DP700
CasosEvenstrem
Challenge_Dev
Challenge_Prod
Copilot
Microsoft Fabric Capacity Metrics
Fabric_Data_Agent
...
```

4. El recuento devuelto fue:

```text
26 workspaces en total
25 workspaces si se excluye "My workspace"
```

Esto confirma que:

- Codex arranco el proxy local correctamente.
- El proxy obtuvo token mediante Azure CLI.
- El proxy conecto con `https://api.fabric.microsoft.com/v1/mcp/core`.
- Fabric devolvio datos reales autorizados para la cuenta.

---

## 13. Solucion de problemas

### Error: Azure CLI no devuelve token

Probar:

```powershell
az login
```

Luego:

```powershell
az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv
```

### Error: no se encuentra `az`

El proxy busca Azure CLI en rutas habituales de Windows.

Si no lo encuentra, se puede indicar la ruta manualmente:

```powershell
$env:FABRIC_AZ_COMMAND = "C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
```

### Error: timeout al arrancar

Revisar:

- que Node esta instalado
- que `C:\Users\vicen\fabric-mcp-proxy\index.js` existe
- que `npm install` se ejecuto en la carpeta del proxy
- que `startup_timeout_sec` no sea demasiado bajo

### Error: 401 Unauthorized

El proxy ya intenta refrescar el token automaticamente.

Si persiste:

```powershell
az login
```

Y despues recargar VS Code o reiniciar el MCP.

### Quiero ver mas logs

Se puede activar:

```powershell
$env:FABRIC_PROXY_DEBUG = "1"
```

Despues reiniciar el proxy o recargar Codex.

---

## 14. Resumen final

La configuracion actual no usa un login OAuth propio del proxy ni guarda `token.json`.

La solucion real es:

```text
Codex
  -> MCP local fabric_remote_core
  -> node C:\Users\vicen\fabric-mcp-proxy\index.js
  -> Azure CLI obtiene token para https://api.fabric.microsoft.com
  -> Proxy llama a https://api.fabric.microsoft.com/v1/mcp/core
  -> Fabric devuelve herramientas y datos reales
```

El motivo de usar este proxy es evitar que Codex tenga que resolver directamente la autenticacion OAuth del MCP remoto de Fabric.
El proxy aprovecha la sesion ya gestionada por Azure CLI y mantiene la configuracion de Codex limpia, sin tokens fijos ni secretos escritos en `config.toml`.
