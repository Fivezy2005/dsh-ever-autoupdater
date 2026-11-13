## MODIFIED Requirements

### Requirement: 手动更新 Manual updates

The updater SHALL run a manual check or update on request, use the same detection, ordering and rollback rules as a scheduled run, and SHALL NOT start an update while an agent is running unless the request carries an explicit confirmation.

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
