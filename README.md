# Video To Audio

App desktop **local** (Electron + TypeScript) para extrair o áudio de gravações
de reuniões. Nenhum arquivo sai da sua máquina: não há upload, não há serviço
externo, não há limite de tamanho — o processamento é feito pelo `ffmpeg` que
vem empacotado junto com o app.

Esta é a **Fase 1** de um projeto maior (vídeo → áudio → texto → estudo com IA).
Veja o [Roadmap](#roadmap--próximas-fases).

## Por que existe

Reuniões de mais de 1 hora geram vídeos de vários GB. Conversores online
costumam ter limite de 1 GB e, pior, exigem enviar conteúdo potencialmente
sensível/confidencial para servidores de terceiros. Este app resolve os dois
problemas: roda offline e não tem limite prático de tamanho ou duração.

## Funcionalidades (Fase 1)

- Selecionar o vídeo por diálogo nativo **ou arrastando e soltando** na janela.
- Extrair o áudio em **MP3** (padrão, mono 128 kbps) ou **WAV** (PCM 16 bits,
  16 kHz mono — sem perdas e já no formato que a maioria dos modelos de
  transcrição prefere, pensando na Fase 2).
- **Redução de ruído opcional** (checkbox), em dois níveis — remove chiado de
  microfone, zumbido e ar-condicionado, e nivela o volume. Veja
  [Como funciona a redução de ruído](#como-funciona-a-redução-de-ruído).
- **Barra de progresso real**, calculada a partir da duração do vídeo, com
  tempo processado / tempo total.
- **Cancelar** uma extração em andamento (o arquivo parcial é removido).
- Salvar na **mesma pasta do vídeo** (padrão) ou numa **pasta de saída
  escolhida**. O nome do áudio segue o nome do vídeo, e arquivos existentes
  nunca são sobrescritos (`reuniao.mp3`, `reuniao (1).mp3`, …). Com a limpeza
  ligada, o nome ganha o sufixo ` - limpo`, para dar para comparar as versões.
- Botões para **abrir a pasta** do resultado ou **abrir o áudio** no player padrão.
- **Erros claros na interface**: arquivo que não é vídeo, vídeo sem faixa de
  áudio, falha do ffmpeg (com as últimas linhas do log).

A UI **nunca trava**: o ffmpeg roda como processo filho no main process, e o
renderer só recebe eventos de progresso.

## Como funciona a redução de ruído

Tudo acontece **numa passada só**, durante a própria extração — não é preciso
extrair e depois tratar o áudio em outro programa.

Antes de converter, o app faz uma análise rápida (os primeiros 2 minutos) para
**medir o piso de ruído real da gravação**. Esse valor alimenta o denoiser: sem
ele, um ajuste fixo ou não limparia nada numa gravação ruim, ou comeria a voz
numa gravação que já estava boa.

A cadeia de filtros do ffmpeg é:

| Filtro        | Leve            | Forte             | Para que serve                                                   |
| ------------- | --------------- | ----------------- | ---------------------------------------------------------------- |
| `highpass`    | 80 Hz           | 100 Hz            | Corta zumbido de rede, trepidação de mesa e sopro                 |
| `afftdn`      | `nr=18`         | `nr=28`           | Denoiser por FFT — é o que mata o chiado constante (`nf` medido)  |
| `lowpass`     | —               | 9 kHz             | Acima disso, em reunião, quase só sobra chiado                    |
| `deesser`     | —               | `i=0.4`           | Segura o "sss" estridente que o denoiser realça                   |
| `dynaudnorm`  | ✓               | ✓ (mais firme)    | Nivela o volume de quem falou longe do microfone                  |

A ordem importa: primeiro se tira o que claramente não é voz, depois o
denoiser, e só no fim se normaliza o volume — normalizar antes só amplificaria
o ruído.

**Qual escolher?** Comece no **Leve**: ele resolve o caso comum (chiado de
microfone, ar-condicionado) sem risco de estragar a voz. Use o **Forte** só em
gravações realmente ruins — ele limita a faixa de frequências à da voz, o que
limpa mais, mas pode deixar o som um pouco abafado ou metálico.

Medições em áudio de teste (relação voz/chiado, quanto maior melhor):

| Gravação      | Sem limpeza | Leve       | Forte      |
| ------------- | ----------- | ---------- | ---------- |
| Bem ruidosa   | +1,1 dB     | **+7,0 dB** | +7,8 dB   |
| Já limpa      | +27,1 dB    | **+40,9 dB** | +42,7 dB |

O custo é baixo: numa gravação de 20 minutos, a conversão passou de 2,7 s para
3,1 s (análise + filtros incluídos).

> Se mesmo assim ficar ruidoso, o ganho maior costuma estar na origem: microfone
> mais perto de quem fala e supressão de ruído ativada na própria ferramenta de
> reunião (Meet/Teams/Zoom) na hora de gravar.

## Requisitos

- [Node.js](https://nodejs.org/) 18 ou superior (inclui o `npm`).
- Windows 10/11 (é o alvo do build). O código também roda em macOS/Linux.
- **Não** é preciso instalar o ffmpeg: `ffmpeg-static` e `ffprobe-static`
  trazem os binários como dependência do projeto.

## Instalação e execução (desenvolvimento)

```bash
# 1. Clone o repositório e entre na pasta
git clone https://github.com/pedroeli07/video-to-audio-to-text.git
cd video-to-audio-to-text

# 2. Instale as dependências (baixa o Electron e os binários do ffmpeg)
npm install

# 3. Compile o TypeScript e abra o app
npm run dev
```

### Scripts disponíveis

| Script              | O que faz                                                        |
| ------------------- | ---------------------------------------------------------------- |
| `npm run dev`       | Compila o TypeScript e abre o app                                |
| `npm start`         | Abre o app usando o que já está compilado em `dist/`             |
| `npm run compile`   | Só compila (TypeScript + cópia do HTML/CSS para `dist/`)         |
| `npm run build`     | Gera o instalador Windows (NSIS) em `release/`                    |
| `npm run build:dir` | Gera só a pasta do app (sem instalador) — útil para testar rápido |
| `npm run clean`     | Apaga `dist/` e `release/`                                        |

## Gerando o instalador

```bash
npm run build
```

O instalador `.exe` (NSIS, com escolha de pasta de instalação) aparece em
`release/`. O `electron-builder` está configurado com `asarUnpack` para os
binários do ffmpeg/ffprobe — eles precisam ficar fora do `app.asar` para serem
executáveis, e o código já ajusta o caminho para `app.asar.unpacked`.

> Para um ícone próprio, coloque um `icon.ico` (256×256) em `build/`;
> o electron-builder o usa automaticamente.

## Estrutura do projeto

```
src/
├─ main/                  # Main process (Node.js): arquivos, ffmpeg, IPC
│  ├─ main.ts             # janela, handlers de IPC
│  ├─ audio-extractor.ts  # ffprobe, análise de ruído, filtros e conversão
│  └─ ffmpeg-setup.ts     # resolve os binários empacotados (asar.unpacked)
├─ preload/
│  └─ preload.ts          # contextBridge: a única ponte renderer ⇄ main
├─ renderer/              # Interface (HTML/CSS/TS puro, sem framework)
│  ├─ index.html
│  ├─ styles.css
│  └─ renderer.ts
├─ shared/
│  └─ types.ts            # tipos usados pelos dois lados do IPC
└─ types/                 # declarações para libs sem tipagem
```

### Decisões de arquitetura

- **`contextIsolation: true` e `nodeIntegration: false`** — o renderer não tem
  acesso a Node. Tudo passa pela API mínima exposta no `preload.ts`, e o
  `index.html` ainda declara uma CSP restritiva (sem código remoto, sem `eval`).
- **Sem framework no renderer** — a tela tem uma dropzone, dois selects e três
  botões; React só adicionaria build e dependências para pouco ganho.
- **Tipos compartilhados em `src/shared/types.ts`** — os dois lados do IPC
  usam os mesmos tipos, então uma mudança de contrato quebra a compilação em
  vez de quebrar em runtime.
- **Um job por vez** — simplifica o cancelamento e evita disputar CPU entre
  conversões longas.
- **Caminho do arquivo arrastado via `webUtils.getPathForFile`** — é a forma
  suportada pelo Electron moderno com `contextIsolation` ligado.

## Roadmap / Próximas Fases

> Nada abaixo está implementado. É o planejamento do projeto.

### Fase 2 — Transcrição do áudio para texto
Converter o áudio extraído em texto usando speech-to-text. A definir entre uma
solução **local** (ex.: `whisper.cpp` / `faster-whisper`, que mantém o conteúdo
das reuniões na máquina) ou **via API**. Prioridade para a opção local, pelo
mesmo motivo de confidencialidade que motivou a Fase 1. É por isso que o WAV
16 kHz mono já é uma opção de saída aqui.

### Fase 3 — Armazenamento das transcrições
Guardar as transcrições em banco de dados, com metadados por reunião (data,
título, participantes, duração, caminho do vídeo/áudio original). Provável
escolha: **SQLite** local, por ser um único arquivo e não exigir servidor.

### Fase 4 — Estudo assistido por IA
Integrar uma IA com acesso ao histórico de transcrições armazenado, para
consultar e estudar os conceitos de *factoring* discutidos nas reuniões
("o que foi dito sobre risco sacado?", "resuma as reuniões de março").
Provavelmente busca semântica sobre os trechos + geração de resposta com
citação da reunião de origem.

## Solução de problemas

| Problema                                              | O que fazer                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "não parece ser um vídeo válido"                      | O arquivo pode estar corrompido ou incompleto. Teste abri-lo num player.                          |
| "não possui nenhuma faixa de áudio"                   | A gravação foi feita sem áudio — não há o que extrair.                                            |
| Progresso fica em 0% e a duração aparece "desconhecida" | Alguns arquivos (gravações interrompidas) não têm duração nos metadados; a conversão ainda funciona. |
| Voz ficou abafada ou "metálica"                       | Você usou o nível Forte. Refaça no Leve — o arquivo antigo não é sobrescrito.                        |
| Ainda tem chiado com a limpeza ligada                 | Tente o nível Forte. Ruído variável (obra, conversa ao fundo) é bem mais difícil que chiado constante. |
| Erro do ffmpeg no app instalado                       | Confirme que o build manteve o `asarUnpack` do `package.json`.                                     |

## Licença

MIT — uso pessoal.
