// Pure generators for the Task Scheduler logon task and its hidden launcher.
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** Windows command-line quoting for one argument. */
export function quoteArg(arg) {
  const s = String(arg);
  return /[\s"]/.test(s) || s === "" ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** Task Scheduler 1.2 XML: runs at logon of `userId`, as that user, not elevated, restarts on failure. */
export function taskXml({
  command,
  args = [],
  workDir,
  userId,
  description = "FRIDAY background services",
  delay = "PT15S",
}) {
  const argLine = args.map(quoteArg).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${esc(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(userId)}</UserId>
      <Delay>${esc(delay)}</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(command)}</Command>${argLine ? `\n      <Arguments>${esc(argLine)}</Arguments>` : ""}${workDir ? `\n      <WorkingDirectory>${esc(workDir)}</WorkingDirectory>` : ""}
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * VBScript that starts a command with window style 0 (hidden). A console program started by
 * Task Scheduler in the user's session would flash a console window; wscript //B does not.
 */
export function launcherVbs({ command, args = [] }) {
  const line = [command, ...args].map(quoteArg).join(" ");
  const vb = line.replace(/"/g, '""');
  return `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${vb}", 0, False\r\n`;
}
