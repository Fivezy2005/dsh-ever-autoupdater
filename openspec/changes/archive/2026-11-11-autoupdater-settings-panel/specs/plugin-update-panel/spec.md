## ADDED Requirements

### Requirement: 本机接口 Local-only endpoints

The updater SHALL expose an overview endpoint, a settings endpoint and an action endpoint under `/api/dsh-ever-autoupdater/`, and SHALL answer every request that does not come from the loopback address with 403 without reading or changing anything.

#### Scenario: 本机请求总览
- **WHEN** a loopback client requests the overview
- **THEN** the response contains the host version, the last and next check times, the running agents, the pending updates, the effective settings and the last run report

#### Scenario: 非本机请求被拒绝
- **WHEN** a request arrives from a non-loopback address
- **THEN** the response is 403 and no state is read or written

### Requirement: 用户设置的持久化与覆盖 Persisted user settings

The updater SHALL store settings changed in the panel in `<DSH_HOME>/autoupdater/settings.json`, accept only the known keys with valid values, and apply them over the shipped defaults at the next run and at the next scheduler re-arm.

#### Scenario: 保存有效设置
- **WHEN** the user saves `autoApply: true` and `intervalHours: 6`
- **THEN** `settings.json` holds both values and the scheduler is re-armed with a 6-hour interval

#### Scenario: 无效值被拒绝
- **WHEN** a save request contains an unknown key or an out-of-range value
- **THEN** the response is 400 with the reason and `settings.json` is unchanged

#### Scenario: 不可移除的跳过项
- **WHEN** the saved `skipPackages` omits `dsh-ever-autoupdater`
- **THEN** the effective configuration still contains it

### Requirement: 手动更新 Manual updates

The updater SHALL run a manual check or update on request, use the same detection, compatibility and rollback rules as a scheduled run, and SHALL NOT start an update while an agent is running unless the request carries an explicit confirmation.

#### Scenario: 立即检查
- **WHEN** the user requests a check
- **THEN** a run starts with the manual reason, applies nothing, and the new report is returned

#### Scenario: 会话在运行时未确认
- **WHEN** an update is requested while an agent is running and the request carries no confirmation
- **THEN** nothing is changed and the response lists the running agents and asks for confirmation

#### Scenario: 会话在运行时已确认
- **WHEN** the same update is requested again with confirmation
- **THEN** the selected packages are updated in the normal sequence, ignoring the running-agent deferral

#### Scenario: 更新选中项
- **WHEN** the user updates selected packages
- **THEN** only those packages are updated and the per-run limit does not apply

#### Scenario: 已有运行在进行
- **WHEN** a run is already in progress
- **THEN** the request is refused with a message and no second run starts

### Requirement: 跳过版本 Skipping a version

The updater SHALL remember a skipped target version per package, SHALL NOT list or apply that version again, and SHALL list a newer version of the same package again.

#### Scenario: 跳过后不再提示
- **WHEN** the user skips `pkg@2.0.0`
- **THEN** later checks omit `pkg@2.0.0` from the pending updates

#### Scenario: 更新的版本重新出现
- **WHEN** `pkg@2.1.0` is published after `pkg@2.0.0` was skipped
- **THEN** `pkg@2.1.0` is listed as a pending update

### Requirement: 设置页栏目 Settings section

The updater SHALL seat a first-level section named 「插件更新」 in the settings page showing status, pending updates with per-row update and skip buttons, check and update-all buttons, the editable settings and the last run history including reasons for failed, rolled-back and skipped items.

#### Scenario: 打开栏目
- **WHEN** the user opens the section
- **THEN** it shows data from the overview endpoint and refreshes it while the section is visible

#### Scenario: 更新需确认
- **WHEN** an update response asks for confirmation
- **THEN** the section shows the running agents and sends the update again with confirmation only if the user confirms
