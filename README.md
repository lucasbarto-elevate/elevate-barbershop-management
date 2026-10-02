ELEVATE BARBERSHOP — VERSÃO CORRIGIDA V3

Mantém o sistema online + offline, sincronização por Netlify Functions + Netlify Blobs e a correção da data atual do Dashboard.

Correções desta versão:
- service worker versionado para evitar cache antigo;
- navegação do site não é interceptada por cache durante o acesso online;
- manifest.json incluído;
- cache antigo do Elevate é removido automaticamente;
- sincronização /api/data e /api/sync preservada;
- não altera o domínio público elevatebarbershop.ie.
