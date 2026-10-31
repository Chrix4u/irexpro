#ifndef MyAppVersion
#define MyAppVersion "0.2.0"
#endif

[Setup]
AppId={{6B37B3CA-73AA-4FF7-A0A9-9A9F879E6021}
AppName=iRexPro MT5 Connector
AppVersion={#MyAppVersion}
AppPublisher=Lightworld Technologies Ltd.
DefaultDirName={autopf}\iRexPro MT5 Connector
DefaultGroupName=iRexPro
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=output
OutputBaseFilename=iRexPro-MT5-Connector-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=iRexPro MT5 Connector

[Files]
Source: "..\dist\iRexPro-MT5-Connector.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\iRexPro MT5 Connector"; Filename: "{app}\iRexPro-MT5-Connector.exe"
Name: "{autodesktop}\iRexPro MT5 Connector"; Filename: "{app}\iRexPro-MT5-Connector.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Run]
Filename: "{app}\iRexPro-MT5-Connector.exe"; Description: "Launch iRexPro MT5 Connector"; Flags: nowait postinstall skipifsilent
