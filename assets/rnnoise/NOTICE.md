# Modelo RNNoise

O arquivo `bd.rnnn` é um modelo pré-treinado do [RNNoise](https://github.com/xiph/rnnoise),
usado pelo filtro `arnndn` do ffmpeg para reduzir ruído em gravações de voz.

- **Origem:** https://github.com/GregorR/rnnoise-models
  (diretório `beguiling-drafter-2018-08-30`, arquivo `bd.rnnn`)
- **Licença:** o repositório de origem declara que, com exceção do diretório
  `tools/` e do README, "none of this work is creative and thus none of it is
  subject to copyright" — ou seja, os modelos não estão sujeitos a direitos autorais.
- **Por que este modelo:** na tabela do repositório ele é o treinado para
  "sinal de gravação + ruído de voz", e foi o que teve melhor resultado nos
  testes objetivos deste projeto (veja a seção de redução de ruído no README).

O RNNoise em si é BSD-3-Clause (Xiph.Org / Mozilla); aqui ele entra apenas
através do ffmpeg, que já é distribuído com o app.
