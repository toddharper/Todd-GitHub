# Venue Network Atlas

Directory of Legends venues with site contacts, network equipment, circuits, IP addressing and site diagrams.

**Live version:** https://claude.ai/artifact/KkQJHB62FN5tMmc7Ma93C5. Edit venues there. Access is managed from the page's Share menu.

This repository holds the page source and a point-in-time backup of the venue data. The page reads and saves its data through claude.ai, so opening `index.html` from GitHub or GitHub Pages shows the layout without any venues.

## Contents

| Path | What it is |
| --- | --- |
| `index.html` | Page source |
| `data/venues.json` | Full export of every venue record, including circuits and IP rows |
| `data/venues.csv` | One row per venue: address, portfolio, status, main contact, venue tech, notes |
| `data/circuits.csv` | One row per circuit: carrier, circuit/account ID, bandwidth, WAN IP, gateway, support |
| `data/ip-addresses.csv` | One row per subnet or address |

## Snapshot

Exported October 23, 2026:

- 106 venues: 59 Legends (5 obsolete), 41 Live Nation, 6 Real Madrid
- 80 circuits
- 53 IP address entries

The data was merged from these spreadsheets:

- Legends-Site-Circuit.xlsx
- Legends-Site_List-Contacts.xlsx
- Circuit-Comprehensive.xlsx

Venues with conflicting source data carry a note that begins "Import review:". The page lists them under its **Needs review** filter.

## Sensitive data

The data files contain staff contact details, public IP addresses and carrier circuit IDs. Keep this repository private.
