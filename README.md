# Video To Audio

App desktop (Electron + TypeScript) para extrair o áudio de gravações de
reuniões e, opcionalmente, transcrevê-lo em texto separando quem falou.

**A extração e a limpeza de áudio são 100% locais**: sem upload, sem serviço
externo, sem limite de tamanho — quem faz o trabalho é o `ffmpeg` empacotado
junto com o app.

**A transcrição é a única parte que usa a internet.** Ela é opcional, desligada
por padrão, e só acontece quando você clica em "Transcrever": aí o áudio é
enviado para a [AssemblyAI](https://www.assemblyai.com). Veja
[Transcrição](#transcrição-com-separação-de-locutores).

Isto cobre a **Fase 1** (áudio) e a **Fase 2** (texto) de um projeto maior
(vídeo → áudio → texto → estudo com IA). Veja o
[Roadmap](#roadmap--próximas-fases).

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
- **Redução de ruído por rede neural** (opcional, dois níveis) — o RNNoise
  identifica a voz quadro a quadro e atenua só o resto. Veja
  [Como funciona a redução de ruído](#como-funciona-a-redução-de-ruído).
- **Prévia de 30 segundos** para testar as opções antes de processar o vídeo inteiro.
- **Nivelamento de volume** opcional, para quem falou longe do microfone.
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

## Funcionalidades (Fase 2)

- **Transcrição em texto com separação de quem falou** (`Pessoa 1:`, `Pessoa 2:`),
  com marcação de tempo em cada fala.
- **Escolha entre dois modelos** (Universal-2 e Universal-3.5 Pro) para
  transcrever a mesma reunião nos dois e comparar antes de decidir qual usar.
- **Chave da API cifrada pelo cofre do Windows**, nunca em texto puro.
- **Transcrever um áudio já extraído**, sem precisar reprocessar o vídeo.
- **Cancelar** uma transcrição em andamento (inclusive durante o upload).

Detalhes, preços e como obter a chave: [Transcrição](#transcrição-com-separação-de-locutores).

## Como funciona a redução de ruído

A limpeza usa o **RNNoise** (filtro `arnndn` do ffmpeg): uma rede neural
treinada especificamente para separar **voz** de ruído. A cada quadro de 10 ms
ela estima se há fala e o quanto de cada banda de frequência é ruído, e atenua
só o ruído — é o "detectar quem está falando e limpar o resto" na prática.

Isso é diferente de um denoiser espectral clássico (`afftdn`), que só sabe
distinguir "o que é constante": ele acaba ou deixando o ruído passar, ou comendo
a voz junto. Nos testes deste projeto o afftdn chegou a **piorar** o áudio.

Tudo acontece numa passada só, durante a extração. Não é preciso extrair e
depois tratar em outro programa.

| Nível     | Cadeia de filtros                                    |
| --------- | ---------------------------------------------------- |
| **Leve**  | `arnndn` com `mix=0.85` (mantém 15% do sinal original, o que mascara artefatos da rede) |
| **Forte** | `arnndn` em mix cheio + `afftdn` leve para o chiado residual |

O **nivelamento de volume** (`dynaudnorm`) é uma opção separada, porque é outro
problema: ele deixa audível quem falou longe do microfone, mas não reduz ruído.

### Medições

Teste objetivo com fala real (trecho de discurso do JFK, 16 kHz) misturada a
ruído em níveis controlados. A métrica é SDR contra o áudio limpo de
referência, com alinhamento de ganho e atraso — quanto maior, mais perto do
original limpo. "Antiga" é a cadeia que este projeto usava antes (highpass +
afftdn + dynaudnorm).

| Cenário                | Sem tratar | Antiga | **Leve** | **Forte** |
| ---------------------- | ---------- | ------ | -------- | --------- |
| Chiado leve            | 15,1 dB    | −2,1   | **+1,8** | +0,9      |
| Chiado forte           | 6,2 dB     | +2,1   | **+5,6** | +5,8      |
| Chiado extremo         | 3,0 dB     | +0,9   | +5,6     | **+6,5**  |
| Vozes ao fundo (leve)  | 15,1 dB    | −3,6   | **−1,3** | −2,2      |
| Vozes ao fundo (forte) | 6,2 dB     | −0,5   | **+0,8** | +0,8      |
| Áudio já limpo         | —          | 13,3   | **19,5** | 18,0      |

Leitura dos números:

- A cadeia antiga **piorava** o áudio em ruído leve e com vozes ao fundo. Por
  isso ela foi substituída.
- O **Leve** é o melhor equilíbrio: ganha em quase tudo e é o que menos
  introduz artefato quando a gravação já estava boa (19,5 dB).
- O **Forte** só compensa em gravação bem ruidosa.
- **Vozes ao fundo (babble) continuam sendo o caso difícil** — nenhum dos dois
  resolve. Isso é uma limitação conhecida do RNNoise, não um defeito da
  configuração.

### Prévia de 30 segundos

Como testar a limpeza numa reunião de 1 h é caro, o botão **"Ouvir prévia de
30s"** converte só um trecho do meio da gravação (numa reunião de 20 min isso
levou 0,6 s) e abre no player. Ajuste as opções, ouça, e só então extraia o
arquivo inteiro.

> Se mesmo com a limpeza o áudio continuar ruim, o ganho maior está na origem:
> microfone mais perto de quem fala e supressão de ruído ativada na própria
> ferramenta de reunião (Meet/Teams/Zoom) na hora de gravar. Uma gravação
> saturada ou com o áudio já degradado na origem não tem como ser recuperada
> depois.

## Transcrição com separação de locutores

O card **"Transcrição (opcional)"**, no fim da tela, converte o áudio extraído
em um arquivo `.txt` já separando quem falou:

```
Transcrição de: reuniao.mp3
Modelo: Universal-2
Locutores identificados: 3
Gerado em: 09/09/2026, 14:30:00
------------------------------------------------------------

[00:00:12] Pessoa 1: Hoje nós iremos apresentar a conciliação.

[00:00:16] Pessoa 2: Perfeito, pode seguir.

[00:00:18] Pessoa 1: O risco sacado ficou em aberto.
```

Os rótulos seguem a **ordem de entrada na conversa** — "Pessoa 1" é sempre quem
falou primeiro. Eles são anônimos por natureza: a diarização agrupa vozes, ela
não sabe nomes. Trocar "Pessoa 1" por "Pedro" é edição manual no `.txt`.

> ⚠️ **Esta é a única parte do app que envia dados para fora da sua máquina.**
> O áudio vai para os servidores da AssemblyAI. Para reuniões sensíveis, pense
> se isso é aceitável antes de clicar em Transcrever.

### Os dois modelos

Dá para escolher entre dois modelos, os dois com português e diarização. Eles
existem lado a lado justamente para você transcrever a mesma reunião nos dois e
decidir se o mais caro compensa:

| Modelo | Transcrição | Diarização | Total por hora de áudio |
| ------ | ----------- | ---------- | ----------------------- |
| **Universal-2** | US$ 0,15 | +US$ 0,02 | **US$ 0,17** (~R$ 0,87) |
| **Universal-3.5 Pro** | US$ 0,21 | +US$ 0,02 | **US$ 0,23** (~R$ 1,17) |

O `.txt` sai com o nome do modelo no final (`reuniao - universal-2.txt`,
`reuniao - universal-3-5-pro.txt`), então os dois ficam lado a lado na mesma
pasta para comparar. Nada é sobrescrito: repetir o mesmo modelo gera `(1)`, `(2)`…

Como o app pede **um modelo só** por vez (sem a lista de fallback da API), o
arquivo sempre reflete o modelo que você escolheu — do contrário a comparação
não significaria nada.

### Como criar a conta e pegar a API key

1. Acesse **<https://www.assemblyai.com>** e clique em **Sign up**. Dá para
   entrar com e-mail, Google ou GitHub.
2. Confirme o e-mail, se for pedido.
3. Você cai no painel em **<https://www.assemblyai.com/dashboard/home>**. A
   **API key** aparece logo na página inicial do painel — é uma sequência
   longa de letras e números. Clique para copiar.
   (Se não achar, o passo a passo oficial está
   [neste artigo de suporte](https://support.assemblyai.com/articles/7562135267-how-to-get-your-api-key).)
4. No app, cole a chave no campo **"Chave da API"** e clique em **salvar**.

**Não é preciso cadastrar cartão de crédito.** A conta nova vem com **US$ 50 de
crédito grátis**, o que dá cerca de **290 horas** de reunião no Universal-2 com
diarização — ou seja, a comparação entre os dois modelos sai de graça, com folga.
Quando o crédito acaba a conta simplesmente para de transcrever até você
adicionar um cartão; não há cobrança automática de surpresa.

### Onde a chave fica guardada

A chave é cifrada pelo **cofre de credenciais do sistema operacional** (DPAPI no
Windows) através do `safeStorage` do Electron, e gravada em
`%APPDATA%/video-to-audio-to-text/assemblyai.key`. Ela fica amarrada à sua conta
de usuário do Windows: copiar esse arquivo para outra máquina não serve de nada.

Um `.env` ou um JSON em texto puro deixaria a credencial legível para qualquer
processo do usuário, o que é inaceitável para uma chave que gera custo por uso.
O botão **remover** apaga a chave do computador.

A chave nunca chega ao renderer: quem fala com a API é o main process, então a
CSP restritiva da interface continua valendo (`default-src 'none'`).

### Dicas de qualidade

- **Transcreva o áudio SEM limpeza de ruído.** Parece contraintuitivo, mas o
  RNNoise introduz artefato (veja as [medições](#medições)), e artefato atrapalha
  o modelo de voz que faz a diarização. A limpeza é para o ouvido humano; o
  modelo prefere o áudio cru. Se a gravação for muito ruidosa, use o nível
  **Leve**, nunca o Forte.
- **MP3 sobe mais rápido.** Uma hora em WAV 16 kHz dá ~115 MB; em MP3, ~57 MB.
  A qualidade da transcrição é praticamente a mesma.
- **Fala sobreposta é o caso difícil.** Gravação de Meet vem em um canal só. Com
  as pessoas se revezando, a separação acerta bem; quando falam por cima, erra.

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

O modelo da rede neural vai como `extraResources` (para `resources/rnnoise/`),
fora do `app.asar`: o ffmpeg é um processo externo e não consegue ler de dentro
do asar.

> Para um ícone próprio, coloque um `icon.ico` (256×256) em `build/`;
> o electron-builder o usa automaticamente.

## Estrutura do projeto

```
src/
├─ main/                  # Main process (Node.js): arquivos, ffmpeg, IPC
│  ├─ main.ts             # janela, handlers de IPC
│  ├─ audio-extractor.ts  # ffprobe, filtros de limpeza, prévia e conversão
│  ├─ rnnoise.ts          # localiza o modelo .rnnn (dev e app empacotado)
│  ├─ ffmpeg-setup.ts     # resolve os binários empacotados (asar.unpacked)
│  ├─ transcriber.ts      # cliente da AssemblyAI (upload, diarização, .txt)
│  └─ api-key.ts          # chave da API cifrada pelo cofre do sistema
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
- **Escape do caminho do modelo no filtergraph** — o valor passa por **dois**
  unescapes do ffmpeg (o do filtergraph e o da opção do filtro). Por isso as
  barras do Windows viram `/` (escapá-las não adianta: `C:\video` chega como
  `C:video`) e o `:` leva **duas** barras invertidas. Os caracteres `'`, `,`,
  `;`, `[` e `]` não sobrevivem a nenhuma forma de escape (testado contra o
  ffmpeg); se o caminho de instalação tiver algum deles, o modelo é copiado
  para uma pasta com nome seguro. É a falha clássica que só aparece no app
  instalado.
- **A API de transcrição é chamada do main process, nunca do renderer** — a
  chave nunca cruza a ponte do IPC, e a CSP `default-src 'none'` da interface
  continua valendo. O renderer só manda "transcreva este caminho com este
  modelo" e recebe progresso de volta.
- **Um modelo por requisição, sem a lista de fallback da API** — o campo
  `speech_models` aceita vários modelos em ordem de preferência, mas com
  fallback ligado a API poderia trocar de modelo sem avisar e a comparação
  entre os dois perderia o sentido.

## Roadmap / Próximas Fases

### Fase 2 — Transcrição do áudio para texto ✅ implementada (via API)
Feita com a **AssemblyAI**, com diarização. Veja
[Transcrição](#transcrição-com-separação-de-locutores).

A escolha foi por API, e não pela opção local que estava planejada, porque a
parte difícil não é transcrever — é **separar os locutores**. O Whisper não faz
isso sozinho; a rota local exigiria somar um diarizador (`sherpa-onnx`, ou
`pyannote` com Python + PyTorch embarcado), com resultado pior em fala
sobreposta e mais lento em CPU.

**A opção local continua no radar**, pelo motivo de confidencialidade que
motivou a Fase 1. O desenho já prevê isso: toda a conversa com a API está
isolada em `src/main/transcriber.ts`, atrás da mesma forma de job
(`promise` + `cancel`) que a extração usa. Um motor local entra como uma segunda
implementação, sem mexer na UI nem no IPC.

> Nada abaixo desta linha está implementado. É o planejamento do projeto.

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
| Ainda tem chiado com a limpeza ligada                 | Tente o nível Forte, usando a prévia para comparar. Vozes ao fundo o RNNoise não remove. |
| "Modelo de redução de ruído não encontrado"           | O arquivo `assets/rnnoise/bd.rnnn` sumiu do projeto, ou o build não empacotou o `extraResources`. |
| Erro do ffmpeg no app instalado                       | Confirme que o build manteve o `asarUnpack` do `package.json`.                                     |
| "Chave da API recusada (401)"                         | A chave está incompleta ou foi trocada no painel. Copie de novo em [dashboard/home](https://www.assemblyai.com/dashboard/home) e salve. |
| "Nenhuma chave da API salva"                          | Cole a chave no campo da seção Transcrição e clique em **salvar**. Veja [como obter](#como-criar-a-conta-e-pegar-a-api-key). |
| Transcrição falha citando créditos / cobrança         | Os US$ 50 gratuitos acabaram. Adicione um cartão no painel da AssemblyAI para continuar.           |
| "A API não encontrou fala nenhuma neste áudio"        | O áudio saiu mudo. Ouça a prévia antes de transcrever — pode ser gravação sem faixa de voz.        |
| Locutores trocados ou juntados numa "Pessoa" só       | Transcreva a partir do áudio **sem** limpeza de ruído: o artefato do RNNoise atrapalha a separação de vozes. Fala sobreposta também piora o resultado. |
| A chave sumiu depois de trocar de usuário do Windows  | Ela é cifrada pelo cofre da conta de usuário. Cole a chave de novo nesta conta.                    |

## Licença

MIT — uso pessoal.
