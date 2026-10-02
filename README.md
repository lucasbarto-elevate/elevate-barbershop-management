# Elevate Barbershop — Gestão online + offline

Esta versão mantém o sistema local/offline no iPad e adiciona sincronização compartilhada por Netlify Functions + Netlify Blobs.

## Importante: como publicar

A sincronização depende das Netlify Functions. Por isso, publique este projeto usando **Continuous Deployment (Git)** ou **Netlify CLI**. Um upload simples de arquivos estáticos/Netlify Drop não executa o ciclo de build necessário para preparar as Functions.

### Netlify pelo GitHub (recomendado)
1. Crie um repositório novo no GitHub para este projeto.
2. Envie todos os arquivos desta pasta para o repositório, mantendo `netlify/functions/`.
3. No projeto Netlify `curious-baklava-708217`, escolha **Add new project / Import an existing project** e conecte o repositório.
4. Não altere o domínio do site público `elevatebarbershop.ie`.
5. Use a configuração deste `netlify.toml`.
6. Depois do deploy, teste:
   - `/api/health`
   - `/api/data`
7. Só depois faça o teste do iPad: lance um atendimento no Área dos Barbeiros e confira se ele aparece no Admin.

## Arquitetura
- `index.html`: interface Admin + Área dos Barbeiros.
- `netlify/functions/data.mjs`: leitura do catálogo e dos lançamentos.
- `netlify/functions/sync.mjs`: gravação dos lançamentos e catálogo.
- Netlify Blobs: banco compartilhado persistente.
- `sw.js`: cache do shell para uso offline.

## Segurança operacional
Não coloque senhas, tokens ou chaves privadas dentro do código. As Functions usam o acesso interno do Netlify ao Blobs.
