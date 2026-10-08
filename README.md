ELEVATE BARBERSHOP — VERSÃO CORRIGIDA V3

Mantém o sistema online + offline, sincronização por Netlify Functions + Netlify Blobs e a correção da data atual do Dashboard.

Correções desta versão:
- service worker versionado para evitar cache antigo;
- navegação do site não é interceptada por cache durante o acesso online;
- manifest.json incluído;
- cache antigo do Elevate é removido automaticamente;
- sincronização /api/data e /api/sync preservada;
- não altera o domínio público elevatebarbershop.ie.

## Backups remotos

Os nomes dos stores Netlify Blobs podem ser configurados pelas variáveis `ELEVATE_DB_STORE_NAME`, `ELEVATE_DB_CONTROL_STORE_NAME` e `ELEVATE_DB_BACKUPS_STORE_NAME`. Em produção, sem overrides, são usados os nomes padrão atuais. No site de staging, configure as três variáveis com nomes não vazios, distintos entre si e diferentes de todos os nomes padrão de produção; configuração parcial ou que aponte para qualquer store de produção falha durante a inicialização das Functions. Valores específicos de ambiente não devem ser commitados.

Os backups agendados são executados diariamente às 02:00 UTC pela Scheduled Function `backup-scheduled`. A retenção corre separadamente às 03:00 UTC em `backup-retention`; apaga no máximo 25 snapshots por execução (ajustável por `BACKUP_RETENTION_MAX_DELETES`) e continua na execução seguinte. Uma falha de retenção não invalida o backup criado. O store `elevate-db-backups` mantém snapshots diários por 30 dias e um por mês durante 12 meses por predefinição; `BACKUP_DAILY_DAYS` e `BACKUP_MONTHLY_MONTHS` configuram a política.

`/api/sync`, os backups, a retenção e as restaurações partilham um lease no store `elevate-db-control`. O lease tem TTL de 10 minutos, margem de 2 minutos, geração monotônica e leitura atómica do valor/ETag por `getWithMetadata`; renovação, takeover e release usam CAS. A barreira de recuperação está no mesmo registo e só o owner atual pode alterá-la. `data.mjs` e `version.mjs` são somente leitura e nunca inicializam chaves. Sync guarda um journal antes da primeira mutação; restore cria primeiro um backup de segurança, depois aplica e verifica o snapshot. Um backup usa aproximadamente `2N + 25` operações Blob para `N` entradas: uma leitura da entrada e uma verificação do lease por entrada, mais operações fixas e o commit. Os backups abortam depois do orçamento configurável `BACKUP_MAX_DURATION_MS` (20 segundos por omissão), sem publicar staging incompleto.

Limitação importante: Netlify Blobs não fornece transação atómica que combine o CAS no lease com uma escrita em outra chave/store; `delete` também não aceita ETag condicional. O código verifica ownership imediatamente antes das mutações, usa CAS nas escritas de dados quando há ETag e mantém o lease acima dos limites de runtime das Functions (60s síncrona, 30s Scheduled). Isso reduz fortemente o risco e um owner stale não consegue alterar a barreira de recuperação nem sobrescrever uma versão de chave que mudou, mas não equivale a fencing transacional do store principal. O sistema deve manter qualquer escritor novo dentro desta coordenação.

Para ativar a ferramenta administrativa, configure `BACKUP_READ_TOKEN` e `BACKUP_RESTORE_TOKEN` como variáveis de ambiente para Functions no Netlify, com valores aleatórios fortes e distintos. O endpoint falha fechado se faltar um token ou se os valores forem iguais. Nunca os coloque em `netlify.toml`, HTML ou no navegador. Listagem e preview (incluindo preview de recuperação) usam o token READ; restore e recover exigem o token RESTORE.

Num terminal administrativo, defina `BACKUP_ADMIN_URL` para `https://elevatebarbershop.ie/api/backup-admin` e execute:

```sh
node scripts/backup-admin.mjs list
node scripts/backup-admin.mjs restore snapshots/<id>
node scripts/backup-admin.mjs recovery-status
node scripts/backup-admin.mjs recover
```

A ferramenta pede os tokens sem os mostrar no terminal. A restauração apresenta a pré-visualização, pede confirmação digitada e volta a validar que os dados remotos não mudaram antes de aplicar. A pré-visualização e a restauração são operações administrativas fora do frontend público.

Para inicializar explicitamente um store de staging vazio, configure temporariamente `BACKUP_ALLOW_CATALOG_INITIALIZATION=true` apenas no site de staging e execute `node scripts/backup-admin.mjs initialize-catalog`. A ação exige o token RESTORE, confirmação digitada e stores de staging configurados; é recusada com os defaults de produção. Cria apenas a chave `catalog`, não importa lançamentos de exemplo do seed, não substitui um catálogo parcial e recusa stores com entries ou `sync-version` sem catálogo. Se `database` legado estiver completo, copia somente os campos do catálogo e mantém a chave original. Remova o flag após a inicialização. Depois, execute `backup-scheduled` manualmente e confirme o snapshot.
