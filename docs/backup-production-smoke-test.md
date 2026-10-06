# Backup / Restore: checklist de smoke test pós-deploy

Este procedimento valida a implementação num ambiente Netlify remoto depois de um deploy futuro. **Não foi executado agora; não houve deploy.** Não usar os passos que escrevem dados na produção.

## Regra de isolamento

Executar os testes A–H num **projeto/site Netlify separado**, com Site ID próprio e dados descartáveis. Não basta usar um Deploy Preview ou branch deploy do site de produção: os stores criados por `getStore()` são partilhados entre todos os contextos de deploy do mesmo site. Um preview do site principal pode ler ou escrever nos stores de produção. Confirmar o Site ID/projeto no painel antes de qualquer comando ou pedido autenticado. [Documentação Netlify Blobs: stores site-wide e contextos](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).

Os testes de restore, sync, concorrência, retenção com exclusão e injeção de falhas são **proibidos na produção**. Se só existir o site de produção, limitar a validação a inspeções read-only e, se aprovado operacionalmente, a uma criação de backup (que grava apenas em `elevate-db-backups`). Não executar o teste de restore nem semear dados na produção.

## Pré-requisitos

- [ ] Deploy da versão candidata num site Netlify isolado e descartável; anotar URL e Site ID.
- [ ] Confirmar visualmente no painel que esse é o site isolado e que não é um Deploy Preview do site público.
- [ ] Configurar o site isolado com Functions, Scheduled Functions e acesso Netlify Blobs ativos.
- [ ] Popular o site de teste através do fluxo normal da aplicação com catálogo e algumas entries de teste; incluir um produto com stock conhecido. Registar um baseline de `catalog`, `entries/*`, `sync-version` e `database` (se existir).
- [ ] Disponibilizar `node`, Netlify CLI autenticado para o **site isolado** e um cliente HTTP administrativo que leia credenciais de forma protegida.
- [ ] Ter operador secundário a observar o painel/logs durante os testes de concorrência e falhas.
- [ ] Registar data/hora UTC, deploy ID, Site ID, quantidade inicial de entries e stock conhecido.

## Variáveis Netlify necessárias

Configurar em **Site configuration → Environment variables**, disponíveis para Functions no site isolado:

- `BACKUP_READ_TOKEN`: token forte aleatório para `list`, `preview`, `recovery-status` e `recovery-preview`.
- `BACKUP_RESTORE_TOKEN`: token forte aleatório distinto para `restore` e `recover`.
- `BACKUP_MAX_DURATION_MS`: opcional; orçamento do backup, por omissão 20 000 ms.
- `BACKUP_DAILY_DAYS`: opcional; retenção diária, por omissão 30.
- `BACKUP_MONTHLY_MONTHS`: opcional; retenção mensal, por omissão 12.
- `BACKUP_RETENTION_MAX_DELETES`: opcional; limite de exclusões por execução, por omissão 25.

Não copiar valores para este documento, tickets, terminal gravado, frontend, HTML, localStorage ou logs. Os dois tokens têm de estar definidos e ser diferentes; caso contrário o endpoint administrativo deve devolver erro de configuração e falhar fechado. Não configurar tokens em `netlify.toml`.

Para os exemplos `netlify blobs:*`, ligar a CLI ao site isolado e confirmar o contexto antes de executar. Usar apenas `blobs:list` e `blobs:get` para inspeção. Não usar `blobs:set`, `blobs:delete` ou `deleteAll` neste runbook.

## Convenções e registo de evidências

Por cada passo, preencher:

| Campo | Valor |
|---|---|
| Site ID isolado / URL | |
| Deploy ID / commit | |
| Data/hora UTC | |
| Entries antes/depois | |
| Backup ID / chave | |
| Duração observada | |
| Resultado / link para logs | |

Classificar cada item como **PASS**, **FAIL** ou **BLOCKED**. Anexar IDs e hashes, nunca tokens. Falha inesperada, estado de recuperação ativo ou diferença não explicada interrompe os testes de mutação até análise.

## A) Backup manual, snapshot e preservação do principal

1. [ ] Capturar baseline read-only do site isolado: conteúdo JSON de `catalog`, todas as chaves `entries/*`, `sync-version` e `database` se existir. Registar a lista de chaves e hashes/conteúdo canonicalizado. Usar `netlify blobs:list elevate-db --json` e `netlify blobs:get elevate-db <chave> --output <ficheiro-local>` ou ferramenta read-only equivalente.
2. [ ] No painel do site isolado, abrir **Functions → `backup-scheduled`** e usar **Run now**. Não acionar endpoint público não documentado.
3. [ ] Aguardar a resposta/log de sucesso. Guardar horário inicial/final, duration, ID, contagens e checksum reportados. Um timeout, HTTP 503 ou `retryable` é FAIL para esta execução; repetir só após confirmar que não existe operação ativa.
4. [ ] Confirmar que a chave `snapshots/<id>` existe no store `elevate-db-backups`:

   ```sh
   netlify blobs:list elevate-db-backups --prefix snapshots/ --json
   netlify blobs:get elevate-db-backups snapshots/<id> --output ./backup-smoke-snapshot.json
   ```

5. [ ] Validar o snapshot descarregado com o validador do projeto:

   ```sh
   node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { validateSnapshot } from "./netlify/functions/_backup.mjs"; const snapshot = JSON.parse(await readFile(process.argv[1], "utf8")); validateSnapshot(snapshot); console.log(JSON.stringify({ valid: true, format: snapshot.format, timestamp: snapshot.timestamp, counts: snapshot.counts, checksum: snapshot.checksum, hasLegacyDatabase: Object.hasOwn(snapshot, "legacyDatabase"), legacyDatabaseIsNull: snapshot.legacyDatabase === null }, null, 2));' ./backup-smoke-snapshot.json
   ```

   `validateSnapshot` recalcula o checksum e valida formato, IDs, contagens e estrutura. A listagem administrativa também omite snapshots inválidos.

6. [ ] Comparar `catalog`, todas as entries, `sync-version` e `legacyDatabase` do snapshot com o baseline. Se a chave `database` não existia, confirmar `legacyDatabase: null`; se existia, comparar o conteúdo completo.
7. [ ] Capturar novamente o estado do store `elevate-db` e comparar com o baseline: mesmas chaves e valores para catálogo, entries, versão e legacy database. Criação de backup não deve alterar o store principal.
8. [ ] Confirmar que nenhum objeto `staging/*` é listado como snapshot válido; só `snapshots/<id>` publicado e validado conta como backup.

**PASS:** snapshot publicado em `elevate-db-backups`, checksum/format/counts válidos, conteúdo coincide com baseline e o principal permanece igual. **FAIL:** qualquer divergência, snapshot ausente/inválido ou alteração não explicada em `elevate-db`.

## B) Sync funcional e concorrência de clientes

Executar apenas com dados descartáveis no site isolado. Guardar `GET /api/version` antes de cada ciclo.

1. [ ] Criar uma entry sem produtos; confirmar resposta de sucesso, entry remota e aumento de `sync-version`.
2. [ ] Editar a mesma entry; confirmar campos atualizados e versão estritamente maior que a anterior.
3. [ ] Com stock inicial conhecido `S`, criar entry consumindo 2 unidades; stock esperado `S - 2`.
4. [ ] Editar essa entry para consumir 3 unidades no total; stock esperado `S - 3`, sem dupla dedução.
5. [ ] Excluir a entry; stock esperado volta a `S`, entry desaparece e versão aumenta novamente.
6. [ ] Abrir dois clientes separados e iniciar duas sincronizações quase simultâneas. Confirmar que uma operação obtém o lock e a concorrente recebe resposta retryable (por exemplo 503); o cliente deve manter o payload na fila local e tentar novamente.
7. [ ] Confirmar que ambas as alterações ficam remotas depois das tentativas/retries; não aceitar duplicação, perda de entry ou versão regressiva.

**PASS:** criação/edição/exclusão refletem estado e stock corretos; duas operações concorrentes não perdem payload; `sync-version` é monotônica. **FAIL:** payload some, stock diverge, versões repetem/regressam ou um conflito é silenciosamente aceite.

## C) Backup concorrente com sync

1. [ ] No site isolado, preparar baseline conhecido e iniciar `backup-scheduled` via **Run now**.
2. [ ] Durante a leitura do backup, submeter sync de uma entry nova por outro cliente. Usar dados descartáveis.
3. [ ] Confirmar que o sync concorrente é rejeitado como retryable enquanto o backup possui o lock; o cliente mantém a operação pendente.
4. [ ] Validar o snapshot pela secção A: deve corresponder integralmente ao estado baseline anterior ao sync — não uma mistura.
5. [ ] Depois que o backup liberar o lock, repetir/drenar o sync. Confirmar que a entry é persistida e `sync-version` aumenta.
6. [ ] Fazer um segundo backup e confirmar que agora inclui a entry. Comparar os dois snapshots e o estado remoto.

**PASS:** primeiro snapshot é estado completo anterior, sync não concorre nem é perdido, segundo snapshot contém a atualização. **FAIL:** snapshot parcial, sync confirmado sem persistência, payload descartado ou deadlock/lock preso.

## D) Restore controlado

Só no site isolado e com dados descartáveis.

1. [ ] Criar backup `B0` e validar conforme secção A.
2. [ ] Fazer alteração controlada depois de `B0` (entry e stock; opcionalmente campo de catálogo). Registar estado atual e versão.
3. [ ] Pedir preview de `B0` com `BACKUP_READ_TOKEN` através de cliente administrativo seguro. Confirmar checksum, contagens, diferenças de catálogo/entries/produtos, fingerprint atual e versão alvo/atual. Preview não deve escrever no principal.
4. [ ] Confirmar que fingerprint é calculado sobre catálogo, todas as entries, `sync-version` e `database` legacy (inclusive quando ausente). Comparar o preview com o baseline registado.
5. [ ] Executar `node scripts/backup-admin.mjs restore snapshots/<id>`. A ferramenta mostra preview, pede digitação explícita de `RESTORE <backupId>` e depois solicita `BACKUP_RESTORE_TOKEN` sem ecoar o valor.
6. [ ] Confirmar resposta de sucesso somente após validação do estado restaurado. Comparar catálogo/entries/stock com `B0`.
7. [ ] Confirmar `sync-version` novo é estritamente maior que a versão imediatamente anterior ao restore e que a versão guardada em `B0`.
8. [ ] Listar backups e confirmar snapshot `restore-safety` criado automaticamente contém o estado que existia imediatamente antes do restore.
9. [ ] Fazer alteração remota entre preview e restore em outro ensaio isolado. Restore deve abortar por fingerprint divergente, sem escrever; gerar novo preview antes de nova tentativa.

**PASS:** preview não escreve, mudanças desde preview são detectadas, confirmação explícita é exigida, safety backup existe, snapshot aplicado foi relido/verificado e versão é monotônica. **FAIL:** qualquer mutação antes da confirmação, ausência de safety backup, sucesso sem verificação ou divergência.

## E) Falhas controladas, rollback e recovery

Não há parâmetro de fault injection no endpoint administrativo público. **Não** tente provocar falhas desligando permissões, apagando blobs ou manipulando requests na produção. Execute estes casos somente no site isolado, com um harness temporário/local que invoque `applyRestore` e use o hook `afterWrite` exportado pelo módulo; o harness não deve ser publicado nem adicionado ao frontend.

Configurar o harness para usar `getStore` com Site ID do site descartável e credencial administrativa obtida do ambiente seguro, sem literal no ficheiro. Antes de correr, imprimir/confirmar o Site ID (não o token) e exigir um prefixo/chave de backup de teste. Fazer preview do backup e usar o identificador como confirmação.

- [ ] **Rollback bem-sucedido:** injetar uma única exceção em `afterWrite` depois de uma escrita real do restore (ex.: catálogo). `applyRestore` deve reportar falha, reverter para safety backup, verificar rollback e limpar recovery state. Comparar estado atual com o estado pré-restore e confirmar versão monotônica.
- [ ] **Rollback falha:** injetar falha na escrita do restore e manter a falha também durante o rollback. A operação não deve reportar sucesso; recovery state deve permanecer `required: true`; sync, backup, retenção e restore normal devem ser bloqueados.
- [ ] Com recovery ativo, executar `node scripts/backup-admin.mjs recovery-status` e `node scripts/backup-admin.mjs recover`. Verificar que preview exibe o backup/journal e fingerprint; exigir a confirmação digitada; restaurar/reverter; confirmar recuperação verificada e barreira limpa.
- [ ] Interromper um teste sync depois do journal/barreira, antes do commit/rollback. Confirmar que a barreira permanece e a ferramenta administrativa propõe rollback baseado no journal.
- [ ] Interromper restore após a barreira e uma escrita parcial. Confirmar que novas mutações ficam bloqueadas e recovery preview oferece o safety backup.

**PASS:** rollback recupera o estado completo; rollback falhado mantém recovery ativo e bloqueia novas mutações; recovery admin revalida fingerprint/identidade e só libera após concluir/verificar. **FAIL:** recovery é limpo sem validação, mutações passam durante recovery ou a operação relata sucesso parcial.

Se não existir harness temporário aprovado para usar o hook contra o site de teste, marcar esta secção **BLOCKED** — não substituir por falha induzida na produção.

## F) Autorização

Executar contra o endpoint `/api/backup-admin` do **site isolado**, com cliente HTTP administrativo que injete credenciais sem as gravar no histórico ou logs. Não usar frontend.

- [ ] `BACKUP_READ_TOKEN`: `list`, `preview`, `recovery-status` e `recovery-preview` são permitidos.
- [ ] `BACKUP_READ_TOKEN`: pedidos `restore` e `recover` devolvem 401 antes de executar ação; usar corpos incompletos/sem confirmação para que não exista operação destrutiva possível mesmo em caso de erro.
- [ ] `BACKUP_RESTORE_TOKEN`: pedidos `list` e `preview` devolvem 401.
- [ ] `BACKUP_RESTORE_TOKEN`: restore autorizado é confirmado na secção D. Recover autorizado é confirmado na secção E no estado de recovery descartável.
- [ ] Definir temporariamente os dois valores iguais no site isolado; endpoint deve falhar fechado com erro de configuração (503), sem aceitar nenhuma ação. Restaurar configuração distinta após o teste.
- [ ] Remover temporariamente uma variável de cada vez no site isolado; endpoint deve falhar fechado (503). Restaurar configuração após cada ensaio.
- [ ] Procurar tokens acidentalmente em respostas, logs, build output, HTML e localStorage: nenhum valor secreto pode aparecer.

**PASS:** READ/RESTORE têm escopo separado, valores iguais/ausentes são rejeitados e nenhum token aparece em artefactos públicos. **FAIL:** qualquer token de leitura autoriza ação destrutiva ou segredo é exposto.

## G) Scheduled Functions e retenção

1. [ ] No painel Netlify do site isolado, confirmar que `backup-scheduled` aparece como Scheduled Function e que o schedule é `0 2 * * *` (02:00 UTC).
2. [ ] Confirmar também `backup-retention` às `0 3 * * *` (03:00 UTC).
3. [ ] Usar **Run now** em `backup-scheduled`; confirmar nova chave válida em `elevate-db-backups`, sucesso nos logs e duração registada.
4. [ ] Usar **Run now** em `backup-retention` no site isolado; confirmar resultado, duração, `removed`, `remaining` e `complete` nos logs/resposta. Esta função pode apagar objetos de backup; por isso nunca usar para validar num store de produção sem aprovação explícita.
5. [ ] Para validar remoção e política, preparar no site isolado snapshots válidos de teste com datas/chaves antigas e recentes, incluindo mais itens elegíveis do que `BACKUP_RETENTION_MAX_DELETES`. Confirmar que no máximo o limite é apagado por execução, a política diária/mensal é respeitada e execuções seguintes continuam o trabalho.
6. [ ] Confirmar que falha de retenção não remove nem invalida o snapshot criado por `backup-scheduled`.

As Scheduled Functions usam cron UTC e o painel oferece **Run now** após deploy; confirmar disponibilidade e logs no projeto real. [Scheduled Functions Netlify](https://docs.netlify.com/build/functions/scheduled-functions/).

## H) Desempenho e limites

Registar para cada execução:

| Medida | Backup | Retenção |
|---|---:|---:|
| Entries no store principal | | N/A |
| Snapshots no store de backups antes/depois | | |
| Operações Blob estimadas/observadas | | |
| Duração total (ms) | | |
| Tempo máximo por operação/página, se disponível | | |
| Resultado / timeout / retry | | |

- [ ] Medir backup em dados de teste representativos, incluindo maior contagem esperada. O teste local é mock com latência simulada e **não representa** região, rede, cold start, limites ou latência real do Netlify.
- [ ] Como referência de planejamento, a implementação estima aproximadamente `2N + 25` operações Blob para `N` entries; confirmar pelo logging/observabilidade real quando possível.
- [ ] Verificar que o backup termina com margem antes do limite de 30 s Scheduled e do orçamento `BACKUP_MAX_DURATION_MS` (20 s por omissão). Timeout deve falhar sem publicar snapshot incompleto.
- [ ] Medir retenção separadamente; confirmar paginação/listagem, leituras dos candidatos e número limitado de exclusões. Uma falha não invalida snapshots.
- [ ] Medir restore/safety backup com volume semelhante. Restore é síncrono e pode ficar limitado ao timeout de Function; uma interrupção após a barreira deve deixar recovery state ativo e permitir intervenção. Não escalar teste de volume para produção sem um plano de recuperação aprovado.
- [ ] Guardar logs com duração e contagem, sem tokens. Não inferir capacidade de produção a partir dos 39 testes locais.

As durações máximas documentadas variam por tipo de Function; verificar a documentação atual e os settings do site antes do teste. [Function configuration e limites](https://docs.netlify.com/build/functions/configuration/?fn-language=js).

## Procedimento de rollback do teste

Este rollback é para o **site isolado** e usa a ferramenta administrativa já existente; não executar em produção como limpeza de smoke test.

1. [ ] Parar clientes de teste e não enviar mais sync.
2. [ ] Consultar `recovery-status`. Se recovery estiver ativo, não tentar sync ou restore normal.
3. [ ] Se o teste terminou parcialmente, executar `node scripts/backup-admin.mjs recover`, inspecionar preview, comparar safety backup/journal e digitar a confirmação pedida. Usar o token RESTORE quando solicitado.
4. [ ] Confirmar recuperação verificada, recovery state limpo e `sync-version` monotônica.
5. [ ] Se a recuperação falhar novamente, parar as mutações, preservar logs, Site ID, backup ID, safety backup e journal key; escalar para intervenção administrativa. Não apagar stores para “desbloquear”.
6. [ ] Após validar todos os casos, deixar o site de teste isolado e seus stores disponíveis para auditoria; não copiar fixtures para o site principal.

## Critérios antes de considerar produção segura

- [ ] A–H passaram no site Netlify isolado, ou cada item não executado está explicitamente BLOCKED com responsável e plano.
- [ ] Falha de restore, rollback, processo interrompido e recovery foram demonstrados no site isolado; recovery ficou bloqueado até reparação administrativa.
- [ ] Backup e retenção reais têm margens documentadas para o maior volume esperado; foi definida monitorização de falha/timeout e revisão periódica da restauração.
- [ ] Tokens distintos foram configurados apenas no ambiente Netlify; operação administrativa fora do frontend; rotação e responsáveis definidos.
- [ ] Produção continua sem alteração de dados durante smoke; identidade do site verificada antes de cada ação.
- [ ] Fica registado que Netlify Blobs não fornece transação atómica entre CAS do lease e mutação de outra chave; ETags/lease não são fencing transacional. A arquitetura assume limites de runtime e nenhum writer externo ao protocolo. Se a exigência for garantia transacional absoluta mesmo contra operação suspensa/out-of-band writer, não aprovar produção baseada apenas em Blobs.
- [ ] Aprovação operacional separada para qualquer teste destrutivo futuro em produção. Este documento, por si só, não autoriza restore nem deploy.
