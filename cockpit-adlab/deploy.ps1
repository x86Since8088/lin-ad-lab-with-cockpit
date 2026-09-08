<#
.SYNOPSIS
    Windows deployment of cockpit-adlab. There is not one, and this script says
    why rather than pretending.

.DESCRIPTION
    cockpit-adlab is a Cockpit plugin. Cockpit is a Linux service: it serves its
    packages out of /usr/share/cockpit and runs its privileged work through a
    bridge that talks to systemd, polkit and PAM. The AD lab this plugin drives
    is a set of ROOTFUL PODMAN CONTAINERS on a Linux host, and adlab-admin's
    every effect is `podman exec` into one of them.

    None of that has a Windows counterpart, so a deploy.ps1 that copied files
    into C:\Program Files would produce an install that cannot serve a page and
    cannot run a verb - which is worse than no install, because it looks like one.

    This file exists so that an operator who finds a deploy.ps1 next to a
    deploy.sh gets an answer instead of a half-working install. See
    docs/DEPLOY-CONTRACT.md section 1.2: Windows is out of scope for the six
    Cockpit plugins, and the Windows half of the contract is for the components
    that genuinely ship there.

.NOTES
    To manage this lab FROM Windows, point a browser at the Linux host's
    Cockpit (https://<host>:9090) - that is what the plugin is.
#>
[CmdletBinding()]
param()

Write-Host ''
Write-Host 'cockpit-adlab does not deploy to Windows.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  It is a Cockpit plugin. Cockpit serves its packages from'
Write-Host '  /usr/share/cockpit on a Linux host, and this plugin''s helper drives'
Write-Host '  rootful podman containers through `podman exec`. Neither has a'
Write-Host '  Windows equivalent, so there is nothing here to install.'
Write-Host ''
Write-Host '  Deploy on the Linux host that runs the lab:'
Write-Host '      sudo ./deploy.sh                 # -> /opt/cockpit-adlab'
Write-Host ''
Write-Host '  Then manage it from Windows the way it is meant to be managed:'
Write-Host '      https://<that-host>:9090  ->  AD Lab'
Write-Host ''
exit 1
