<div align="center">

<img src="assets/squadjs-logo-white.png#gh-dark-mode-only" alt="Logo" width="500"/>
<img src="assets/squadjs-logo.png#gh-light-mode-only" alt="Logo" width="500"/>

#### SquadJS

[![GitHub release](https://img.shields.io/github/release/Team-Silver-Sphere/SquadJS.svg?style=flat-square)](https://github.com/Team-Silver-Sphere/SquadJS/releases)
[![GitHub contributors](https://img.shields.io/github/contributors/Team-Silver-Sphere/SquadJS.svg?style=flat-square)](https://github.com/Team-Silver-Sphere/SquadJS/graphs/contributors)
[![GitHub release](https://img.shields.io/github/license/Team-Silver-Sphere/SquadJS.svg?style=flat-square)](https://github.com/Team-Silver-Sphere/SquadJS/blob/master/LICENSE)

<br>

[![GitHub issues](https://img.shields.io/github/issues/Team-Silver-Sphere/SquadJS.svg?style=flat-square)](https://github.com/Team-Silver-Sphere/SquadJS/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr-raw/Team-Silver-Sphere/SquadJS.svg?style=flat-square)](https://github.com/Team-Silver-Sphere/SquadJS/pulls)
[![GitHub issues](https://img.shields.io/github/stars/Team-Silver-Sphere/SquadJS.svg?style=flat-square)](https://github.com/Team-Silver-Sphere/SquadJS/stargazers)
[![Discord](https://img.shields.io/discord/266210223406972928.svg?style=flat-square&logo=discord)](https://discord.gg/9F2Ng5C)

<br><br>
</div>

## **About**
SquadJS is a scripting framework, designed for Squad servers, that aims to handle all communication and data collection to and from the servers. Using SquadJS as the base to any of your scripting projects allows you to easily write complex plugins without having to worry about the hassle of RCON or log parsing. However, for your convenience SquadJS comes shipped with multiple plugins already built for you allowing you to experience the power of SquadJS right away.

<br>

## **Using SquadJS**
SquadJS relies on being able to access the Squad server log directory in order to parse logs live to collect information. Thus, SquadJS must be hosted on the same server box as your Squad server or be connected to your Squad server via FTP.

#### Prerequisites
* Git
* [Node.js](https://nodejs.org/en/) (18.x) - [Download](https://nodejs.org/en/)
* [Yarn](https://yarnpkg.com/) (Version 1.22.0+) - [Download](https://classic.yarnpkg.com/en/docs/install)
* Some plugins may have additional requirements.

#### Installation
1. [Download SquadJS](https://github.com/Team-Silver-Sphere/SquadJS/releases/latest) and unzip the download.
2. Open the unzipped folder in your terminal.
3. Install the dependencies by running `yarn install --ignore-engines` in your terminal. Due to the use of Yarn Workspaces it is important to use `yarn install --ignore-engines` and **not** `npm install` as this will not work and will break stuff.
Documentation has been altered slightly from the `yarn install` normal install flow. This is a stop gap until the orignal issue is corrected.
5. Configure the `config.json` file. See below for more details.
6. Start SquadJS by running `node index.js` in your terminal.

**Note** - If you are interested in testing versions of SquadJS not yet released please download/clone the `master` branch. Please also see [here](#versions-and-releases) for more information on our versions and release procedures.

<br>

## **Configuring SquadJS**
SquadJS can be configured via a JSON configuration file which, by default, is located in the SquadJS and is named [config.json](./config.json).

The config file needs to be valid JSON syntax. If an error is thrown saying the config cannot be parsed then try putting the config into a JSON syntax checker (there's plenty to choose from that can be found via Google).

<details>
  <summary>Server</summary>

## Server Configuration

The following section of the configuration contains information about your Squad server.

  ```json
  "server": {
    "id": 1,
    "host": "xxx.xxx.xxx.xxx",
    "queryPort": 27165,
    "rconPort": 21114,
    "rconPassword": "password",
    "logReaderMode": "tail",
    "logDir": "C:/path/to/squad/log/folder",
    "ftp": {
      "host": "xxx.xxx.xxx.xxx",
      "port": 21,
      "user": "FTP Username",
      "password": "FTP Password"
    },
    "sftp": {
      "host": "xxx.xxx.xxx.xxx",
      "port": 22,
      "username": "SFTP Username",
      "password": "SFTP Password"
    },
    "adminLists": [
      {
        "type": "local",
        "source": "C:/Users/Administrator/Desktop/Servers/sq_arty_party/SquadGame/ServerConfig/Admins.cfg",
      },
      {
        "type": "remote",
        "source": "http://yourWebsite.com/Server1/Admins.cfg",
      },
      {
        "type": "ftp",
        "source": "ftp://<user>:<password>@<host>:<port>/<url-path>",
      }
    ]
  },
  ```
* `id` - An integer ID to uniquely identify the server.
* `host` - The IP of the server.
* `queryPort` - The query port of the server.
* `rconPort` - The RCON port of the server.
* `rconPassword` - The RCON password of the server.
* `logReaderMode` - `tail` will read from a local log file, `ftp` will read from a remote log file using the FTP protocol, `sftp` will read from a remote log file using the SFTP protocol.
* `logDir` - The folder where your Squad logs are saved. Most likely will be `C:/servers/squad_server/SquadGame/Saved/Logs`.
* `ftp` - FTP configuration for reading logs remotely. Only required for `ftp` `logReaderMode`.
* `sftp` - SFTP configuration for reading logs remotely. Only required for `sftp` `logReaderMode`.
* `adminLists` - Sources for identifying an admins on the server, either remote or local.

  ---
</details>


<details>
  <summary>Connectors</summary>

## Connector Configuration

Connectors allow SquadJS to communicate with external resources.
  ```json
  "connectors": {
    "discord": "Discord Login Token",
  },
  ```
Connectors should be named, for example the above is named `discord`, and should have the associated config against it. Configs can be specified by name in plugin options. Should a connector not be needed by any plugin then the default values can be left or you can remove it from your config file.

See below for more details on connectors and their associated config.

##### Discord
Connects to Discord via `discord.js`.
  ```json
  "discord": "Discord Login Token",
  ```
Requires a Discord bot login token.


##### Databases
SquadJS uses [Sequelize](https://sequelize.org/) to connect and use a wide range of SQL databases.

The connector should be configured using any of Sequelize's single argument configuration options.

For example:
  ```json
  "mysql": "mysql://user:pass@example.com:5432/dbname"
  ```

or:
  ```json
  "sqlite": {
      "dialect": "sqlite",
      "storage": "path/to/database.sqlite"
  }
  ```

See [Sequelize's documentation](https://sequelize.org/master/manual/getting-started.html#connecting-to-a-database) for more details.

  ---
</details>

<details>
  <summary>Plugins</summary>

## Plugin Configuration

The `plugins` section in your config file lists all plugins built into SquadJS
  ```json
    "plugins": [
      {
        "plugin": "auto-tk-warn",
        "disabled": false,
        "message": "Please apologise for ALL TKs in ALL chat!"
      }
    ]
  ```

The `disabled` field can be toggled between `true`/ `false` to enabled/disable the plugin.

Plugin options are also specified. A full list of plugin options can be seen below.

  ---
</details>

<details>
  <summary>Verboseness</summary>

## Console Output Configuration

The `logger` section configures how verbose a module of SquadJS will be as well as the displayed color.
  ```json
    "logger": {
      "verboseness": {
        "SquadServer": 1,
        "LogParser": 1,
        "RCON": 1
      },
      "colors": {
        "SquadServer": "yellowBright",
        "SquadServerFactory": "yellowBright",
        "LogParser": "blueBright",
        "RCON": "redBright"
      }
    }
  ```
The larger the number set in the `verboseness` section for a specified module the more it will print to the console.

  ---
</details>

<br>

## **Plugins**
The following is a list of plugins built into SquadJS, you can click their title for more information:

Interested in creating your own plugin? [See more here](./squad-server/plugins/readme.md)

<details>
          <summary>DiscordFOBHABExplosionDamage</summary>
          <h2>DiscordFOBHABExplosionDamage</h2>
          <p>The <code>DiscordFOBHABExplosionDamage</code> plugin logs damage done to FOBs and HABs by explosions to help identify engineers blowing up friendly FOBs and HABs.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log FOB/HAB explosion damage to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embeds.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordPlaceholder</summary>
          <h2>DiscordPlaceholder</h2>
          <p>The <code>DiscordPlaceholder</code> plugin allows you to make your bot create placeholder messages that can be used when configuring other plugins.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>command</h4>
           <h6>Description</h6>
           <p>Command to create Discord placeholder.</p>
           <h6>Default</h6>
           <pre><code>!placeholder</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The bot will only answer with a placeholder on this channel</p>
           <h6>Default</h6>
           <pre><code></code></pre></li></ul>
        </details>

<details>
          <summary>DiscordServerStatus</summary>
          <h2>DiscordServerStatus</h2>
          <p>The <code>DiscordServerStatus</code> plugin can be used to get the server status in Discord.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>messageStore (Required)</h4>
           <h6>Description</h6>
           <p>Sequelize connector name.</p>
           <h6>Default</h6>
           <pre><code>sqlite</code></pre></li>
<li><h4>command</h4>
           <h6>Description</h6>
           <p>Command name to get message.</p>
           <h6>Default</h6>
           <pre><code>!status</code></pre></li>
<li><h4>disableSubscriptions</h4>
           <h6>Description</h6>
           <p>Whether to allow messages to be subscribed to automatic updates.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>updateInterval</h4>
           <h6>Description</h6>
           <p>How frequently to update the time in Discord.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>setBotStatus</h4>
           <h6>Description</h6>
           <p>Whether to update the bot's status with server information.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li></ul>
        </details>

<details>
          <summary>AutoKickUnassignedExtended</summary>
          <h2>AutoKickUnassignedExtended</h2>
          <p>The <code>AutoKickUnassignedExtended</code> plugin works like <code>AutoKickUnassigned</code> and can limit warnings and kicks to times when the public queue has players.</p>
          <h3>Options</h3>
          <ul><li><h4>warningMessage</h4>
           <h6>Description</h6>
           <p>Message SquadJS will send to players warning them they will be kicked</p>
           <h6>Default</h6>
           <pre><code>Join a squad, you are unassigned and will be kicked</code></pre></li>
<li><h4>kickMessage</h4>
           <h6>Description</h6>
           <p>Message to send to players when they are kicked</p>
           <h6>Default</h6>
           <pre><code>Unassigned - automatically removed</code></pre></li>
<li><h4>frequencyOfWarnings</h4>
           <h6>Description</h6>
           <p>How often in <b>Seconds</b> should we warn the player about being unassigned?</p>
           <h6>Default</h6>
           <pre><code>30</code></pre></li>
<li><h4>unassignedTimer</h4>
           <h6>Description</h6>
           <p>How long in <b>Seconds</b> to wait before a unassigned player is kicked</p>
           <h6>Default</h6>
           <pre><code>360</code></pre></li>
<li><h4>playerThreshold</h4>
           <h6>Description</h6>
           <p>Player count required for AutoKick to start kicking players, set to -1 to disable</p>
           <h6>Default</h6>
           <pre><code>93</code></pre></li>
<li><h4>roundStartDelay</h4>
           <h6>Description</h6>
           <p>Time delay in <b>Seconds</b> from start of the round before AutoKick starts kicking again</p>
           <h6>Default</h6>
           <pre><code>900</code></pre></li>
<li><h4>ignoreAdmins</h4>
           <h6>Description</h6>
           <p><ul><li><code>true</code>: Admins will <b>NOT</b> be kicked</li><li><code>false</code>: Admins <b>WILL</b> be kicked</li></ul></p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>ignoreWhitelist</h4>
           <h6>Description</h6>
           <p><ul><li><code>true</code>: Reserve slot players will <b>NOT</b> be kicked</li><li><code>false</code>: Reserve slot players <b>WILL</b> be kicked</li></ul></p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>onlyKickIfQueue</h4>
           <h6>Description</h6>
           <p><ul><li><code>true</code>: Only warn and kick unassigned players if there's a public queue</li><li><code>false</code>: Always warn and kick unassigned players</li></ul></p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>ChatCommands</summary>
          <h2>ChatCommands</h2>
          <p>The <code>ChatCommands</code> plugin can be configured to make chat commands that broadcast or warn the caller with present messages.</p>
          <h3>Options</h3>
          <ul><li><h4>commands</h4>
           <h6>Description</h6>
           <p>An array of objects containing the following properties: <ul><li><code>command</code> - The command that initiates the message.</li><li><code>type</code> - Either <code>warn</code> or <code>broadcast</code>.</li><li><code>response</code> - The message to respond with.</li><li><code>ignoreChats</code> - A list of chats to ignore the commands in. Use this to limit it to admins.</li></ul></p>
           <h6>Default</h6>
           <pre><code>[
  {
    "command": "squadjs",
    "type": "warn",
    "response": "This server is powered by SquadJS.",
    "ignoreChats": []
  }
]</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordSeedingAnnouncement</summary>
          <h2>DiscordSeedingAnnouncement</h2>
          <p>The <code>DiscordSeedingAnnouncement</code> plugin sends in-game restart countdowns plus first-seeder, population-aware scheduled, and live-threshold Discord announcements.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the Discord channel for seeding announcements.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>pingGroups</h4>
           <h6>Description</h6>
           <p>Discord role IDs to ping when the first seeder connects. Leave empty to announce without a ping.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "667741905228136459"
]</code></pre>
<li><h4>message</h4>
           <h6>Description</h6>
           <p>Message sent with the role mentions.</p>
           <h6>Default</h6>
           <pre><code>Seeding has started. Join the server and help us seed!</code></pre></li>
<li><h4>restartTime</h4>
           <h6>Description</h6>
           <p>Daily seeding cycle boundary in 24-hour HH:MM format. The game-server restart remains external to SquadJS.</p>
           <h6>Default</h6>
           <pre><code>08:00</code></pre></li>
<li><h4>restartWindowMinutes</h4>
           <h6>Description</h6>
           <p>Minutes after restartTime when first-seeder behavior can arm or catch up.</p>
           <h6>Default</h6>
           <pre><code>120</code></pre></li>
<li><h4>seedingAnnouncementRoles (Required)</h4>
           <h6>Description</h6>
           <p>Discord role IDs to ping in the scheduled seeding announcement.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "667741905228136459"
]</code></pre>
<li><h4>seedingAnnouncementTime</h4>
           <h6>Description</h6>
           <p>Scheduled seeding announcement time in 24-hour HH:MM format.</p>
           <h6>Default</h6>
           <pre><code>13:00</code></pre></li>
<li><h4>seedingAnnouncementWindowMinutes</h4>
           <h6>Description</h6>
           <p>Minutes after seedingAnnouncementTime during which the message can send.</p>
           <h6>Default</h6>
           <pre><code>60</code></pre></li>
<li><h4>seedingAnnouncementMessage</h4>
           <h6>Description</h6>
           <p>Scheduled message used below liveThreshold. Supports {{server.players}} and {{server.name}}.</p>
           <h6>Default</h6>
           <pre><code># Seeding time!
### Seeders: {{server.players}}
Join {{server.name}} and help us seed.</code></pre></li>
<li><h4>alreadyLiveAnnouncementMessage</h4>
           <h6>Description</h6>
           <p>Scheduled message used at or above liveThreshold. Supports {{server.players}} and {{server.name}}.</p>
           <h6>Default</h6>
           <pre><code># Seeding time, and {{server.players}} players are already on {{server.name}}!</code></pre></li>
<li><h4>liveAnnouncementRoles (Required)</h4>
           <h6>Description</h6>
           <p>Discord role IDs to ping when the server first reaches liveThreshold.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "667741905228136459"
]</code></pre>
<li><h4>liveThreshold</h4>
           <h6>Description</h6>
           <p>Player count that triggers the live announcement and selects the scheduled message.</p>
           <h6>Default</h6>
           <pre><code>45</code></pre></li>
<li><h4>liveAnnouncementMessage</h4>
           <h6>Description</h6>
           <p>Live-threshold message. Supports {{server.players}} and {{server.name}}.</p>
           <h6>Default</h6>
           <pre><code># We are live with {{server.players}} players!</code></pre></li>
<li><h4>announcementEmbedDescription</h4>
           <h6>Description</h6>
           <p>Embed description for scheduled and live announcements.</p>
           <h6>Default</h6>
           <pre><code>Server: `{{server.name}}`</code></pre></li>
<li><h4>stateFilePath</h4>
           <h6>Description</h6>
           <p>JSON file that prevents repeat announcements across plugin restarts.</p>
           <h6>Default</h6>
           <pre><code>./discord-seeding-announcement-state.json</code></pre></li>
<li><h4>timeZone</h4>
           <h6>Description</h6>
           <p>IANA time zone used for restartTime and seedingAnnouncementTime.</p>
           <h6>Default</h6>
           <pre><code>UTC</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordKillFeed</summary>
          <h2>DiscordKillFeed</h2>
          <p>The <code>DiscordKillFeed</code> plugin logs all wounds and related information to a Discord channel for admins to review.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log teamkills to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embeds.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>disableCBL</h4>
           <h6>Description</h6>
           <p>Disable Community Ban List information.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordDisconnectWhitelister</summary>
          <h2>DiscordDisconnectWhitelister</h2>
          <p>Auto-whitelists players who trigger <code>PLAYER_DISCONNECTED</code> through AdminSync in Admins.cfg. Only processes players with a linked Discord account (checked via MySquadStats, then the Whitelister API). Players already in a reserve-capable group or kicked by an admin or plugin are skipped. Optionally logs results to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID</h4>
           <h6>Description</h6>
           <p>Channel ID to log whitelist events. Leave empty to disable Discord logging.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>pingUserEnabled</h4>
           <h6>Description</h6>
           <p>Whether to @mention the whitelisted player's Discord account in the log message.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>whitelisterApiUrl (Required)</h4>
           <h6>Description</h6>
           <p>The URL of the Squad Whitelister API.</p>
           <h6>Default</h6>
           <pre><code>http://your-api-url.com</code></pre></li>
<li><h4>whitelisterApiKey (Required)</h4>
           <h6>Description</h6>
           <p>The API key for the Squad Whitelister.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li>
<li><h4>whitelistDurationHours</h4>
           <h6>Description</h6>
           <p>Duration in hours for the whitelist entry.</p>
           <h6>Default</h6>
           <pre><code>0.1</code></pre></li>
<li><h4>remoteWhitelistUrl</h4>
           <h6>Description</h6>
           <p>URL or array of URLs to fetch remote whitelist data from, used to skip players already in a reserve group.</p>
           <h6>Default</h6>
           <pre><code>undefined</code></pre></li><h6>Example</h6>
           <pre><code>https://example.com/whitelist.txt or ["https://example.com/whitelist1.txt", "https://example.com/whitelist2.txt"]</code></pre>
<li><h4>reloadDebounceTime</h4>
           <h6>Description</h6>
           <p>Debounce time in milliseconds before reloading server config after a whitelist change.</p>
           <h6>Default</h6>
           <pre><code>5000</code></pre></li>
<li><h4>blockConfigReloadDuringIntermission</h4>
           <h6>Description</h6>
           <p>Block config reloads between round end and new game start.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>whitelistRefreshIntervalMinutes</h4>
           <h6>Description</h6>
           <p>How often to refresh the remote whitelist cache in minutes. 0 disables periodic refresh.</p>
           <h6>Default</h6>
           <pre><code>10</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordAdminSyncChat</summary>
          <h2>DiscordAdminSyncChat</h2>
          <p>The <code>DiscordAdminSyncChat</code> plugin provides a bidirectional bridge between a Discord channel and in-game admin chat. In-game <code>ChatAdmin</code> messages are forwarded to Discord, and Discord messages in the channel are sent as warnings to all in-game admins with the <code>canseeadminchat</code> permission.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the Discord channel to use for admin sync chat.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>warnDelayMs</h4>
           <h6>Description</h6>
           <p>Delay in milliseconds between consecutive warn messages when a long message is split.</p>
           <h6>Default</h6>
           <pre><code>3000</code></pre></li></ul>
        </details>

<details>
          <summary>DBLog</summary>
          <h2>DBLog</h2>
          <p>The <code>mysql-log</code> plugin will log various server statistics and events to a database. This is great for server performance monitoring and/or player stat tracking.

Grafana:
<ul><li> <a href="https://grafana.com/">Grafana</a> is a cool way of viewing server statistics stored in the database.</li>
<li>Install Grafana.</li>
<li>Add your database as a datasource named <code>SquadJS</code>.</li>
<li>Import the <a href="https://github.com/Team-Silver-Sphere/SquadJS/blob/master/squad-server/templates/SquadJS-Dashboard-v2.json">SquadJS Dashboard</a> to get a preconfigured MySQL only Grafana dashboard.</li>
<li>Install any missing Grafana plugins.</li></ul></p>
          <h3>Options</h3>
          <ul><li><h4>database (Required)</h4>
           <h6>Description</h6>
           <p>The Sequelize connector to log server information to.</p>
           <h6>Default</h6>
           <pre><code>mysql</code></pre></li>
<li><h4>overrideServerID</h4>
           <h6>Description</h6>
           <p>A overridden server ID.</p>
           <h6>Default</h6>
           <pre><code>null</code></pre></li></ul>
        </details>

<details>
          <summary>FogOfWar</summary>
          <h2>FogOfWar</h2>
          <p>The <code>FogOfWar</code> plugin can be used to automate setting fog of war mode.</p>
          <h3>Options</h3>
          <ul><li><h4>mode</h4>
           <h6>Description</h6>
           <p>Fog of war mode to set.</p>
           <h6>Default</h6>
           <pre><code>1</code></pre></li>
<li><h4>delay</h4>
           <h6>Description</h6>
           <p>Delay before setting fog of war mode.</p>
           <h6>Default</h6>
           <pre><code>10000</code></pre></li></ul>
        </details>

<details>
          <summary>SquadCreationLogger</summary>
          <h2>SquadCreationLogger</h2>
          <p>Logs squad creation events to Discord with player information and Steam profile links.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log squad creation events to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>suppressNotifications</h4>
           <h6>Description</h6>
           <p>Whether to suppress Discord notifications for messages sent by this plugin.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>showSquadNumber</h4>
           <h6>Description</h6>
           <p>Whether to show the squad number in the Discord message.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>showFaction</h4>
           <h6>Description</h6>
           <p>Whether to show the faction in the Discord message.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>embedFormat</h4>
           <h6>Description</h6>
           <p>Whether to use Discord embeds (true) or simple text format (false).</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li></ul>
        </details>

<details>
          <summary>TeamRandomizer</summary>
          <h2>TeamRandomizer</h2>
          <p>The <code>TeamRandomizer</code> can be used to randomize teams. It's great for destroying clan stacks or for social events. It can be run by typing, by default, <code>!randomize</code> into in-game admin chat</p>
          <h3>Options</h3>
          <ul><li><h4>command</h4>
           <h6>Description</h6>
           <p>The command used to randomize the teams.</p>
           <h6>Default</h6>
           <pre><code>randomize</code></pre></li></ul>
        </details>

<details>
          <summary>BansCfgCleaner</summary>
          <h2>BansCfgCleaner</h2>
          <p>The <code>BansCfgCleaner</code> plugin automatically clears entries from <code>Bans.cfg</code> and reloads the server configuration when entries are detected. Designed for servers that use BattleMetrics exclusively for banning — any native ban entry is unintended.</p>
          <h3>Options</h3>
          <ul><li><h4>bansCfgPath (Required)</h4>
           <h6>Description</h6>
           <p>Absolute path to the Bans.cfg file.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>/home/container/SquadGame/ServerConfig/Bans.cfg</code></pre>
<li><h4>webhookUrl</h4>
           <h6>Description</h6>
           <p>Discord-compatible webhook URL for notifications when entries are cleared. Leave empty to disable.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>https://discord.com/api/webhooks/123/abc</code></pre>
<li><h4>debounceDelay</h4>
           <h6>Description</h6>
           <p>Milliseconds to wait after a file change event before acting. Absorbs double-fire quirks from fs.watch().</p>
           <h6>Default</h6>
           <pre><code>500</code></pre></li><h6>Example</h6>
           <pre><code>500</code></pre></ul>
        </details>

<details>
          <summary>DiscordRoundEnded</summary>
          <h2>DiscordRoundEnded</h2>
          <p>The <code>DiscordRoundEnded</code> plugin will send the round winner to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log round end events to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li></ul>
        </details>

<details>
          <summary>SquadLeaderRoleValidator</summary>
          <h2>SquadLeaderRoleValidator</h2>
          <p>Enforces proper Squad Leader roles and disbands squads that do not comply after warnings.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log enforcement actions to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>warningIntervalSeconds</h4>
           <h6>Description</h6>
           <p>Interval between warnings for improper SL roles (in seconds).</p>
           <h6>Default</h6>
           <pre><code>30</code></pre></li>
<li><h4>disbandTimeoutSeconds</h4>
           <h6>Description</h6>
           <p>Time before disbanding a squad with improper SL role (in seconds).</p>
           <h6>Default</h6>
           <pre><code>300</code></pre></li>
<li><h4>requiredRolePattern</h4>
           <h6>Description</h6>
           <p>Regular expression pattern that valid SL roles must match.</p>
           <h6>Default</h6>
           <pre><code>SL</code></pre></li><h6>Example</h6>
           <pre><code>SL|SQUAD LEAD|LEADER</code></pre>
<li><h4>enableAutoDisbanding</h4>
           <h6>Description</h6>
           <p>Whether to automatically disband squads that do not comply with role requirements.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>notifyAdmins</h4>
           <h6>Description</h6>
           <p>Whether to notify online admins when a squad is disbanded.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>checkIntervalSeconds</h4>
           <h6>Description</h6>
           <p>How often to check for squad leader roles (in seconds).</p>
           <h6>Default</h6>
           <pre><code>10</code></pre></li>
<li><h4>exemptedLayers</h4>
           <h6>Description</h6>
           <p>Array of layer names that are exempted from SL role validation (e.g., seeding, training layers).</p>
           <h6>Default</h6>
           <pre><code>[
  "Jensen",
  "Seed",
  "Training"
]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "Jensen's Range",
  "Seed",
  "Training"
]</code></pre>
<li><h4>playerThreshold</h4>
           <h6>Description</h6>
           <p>Minimum number of players required for SL role validation to be active.</p>
           <h6>Default</h6>
           <pre><code>30</code></pre></li>
<li><h4>ignoreAdmins</h4>
           <h6>Description</h6>
           <p>Whether to ignore admins from SL role validation. If true, admins will not be subject to SL role requirements.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordTeamkillExtended</summary>
          <h2>DiscordTeamkillExtended</h2>
          <p>The <code>DiscordTeamkillExtended</code> plugin posts teamkills to a Discord channel as one-line messages with Steam profile links.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log teamkills to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre></ul>
        </details>

<details>
          <summary>SquadCreationBlocker</summary>
          <h2>SquadCreationBlocker</h2>
          <p>The <code>SquadCreationBlocker</code> plugin prevents squads with custom names from being created within a specified time after a new game starts and at the end of a round. It includes anti-spam rate limiting with configurable warnings, cooldowns, kick functionality, and optional cooldown reset behavior to prevent players from overwhelming the system.</p>
          <h3>Options</h3>
          <ul><li><h4>blockDuration</h4>
           <h6>Description</h6>
           <p>Time period after a new game starts during which custom squad creation is blocked (in seconds).</p>
           <h6>Default</h6>
           <pre><code>15</code></pre></li>
<li><h4>broadcastMode</h4>
           <h6>Description</h6>
           <p>If true, uses countdown broadcasts. If false, sends individual warnings to players.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>allowDefaultSquadNames</h4>
           <h6>Description</h6>
           <p>If true, allows creation of squads with default names (e.g., "Squad 1") during the blocking period.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>enableRateLimiting</h4>
           <h6>Description</h6>
           <p>Enable anti-spam rate limiting for squad creation attempts.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>rateLimitingScope</h4>
           <h6>Description</h6>
           <p>When to apply rate limiting: "blockingPeriodOnly" or "entireMatch".</p>
           <h6>Default</h6>
           <pre><code>blockingPeriodOnly</code></pre></li>
<li><h4>warningThreshold</h4>
           <h6>Description</h6>
           <p>Number of attempts before issuing warnings to the player.</p>
           <h6>Default</h6>
           <pre><code>3</code></pre></li>
<li><h4>cooldownDuration</h4>
           <h6>Description</h6>
           <p>Duration of cooldown period in seconds after exceeding warning threshold.</p>
           <h6>Default</h6>
           <pre><code>10</code></pre></li>
<li><h4>kickThreshold</h4>
           <h6>Description</h6>
           <p>Number of attempts before kicking the player (0 to disable).</p>
           <h6>Default</h6>
           <pre><code>20</code></pre></li>
<li><h4>pollInterval</h4>
           <h6>Description</h6>
           <p>Interval in seconds for periodic squad checking.</p>
           <h6>Default</h6>
           <pre><code>1</code></pre></li>
<li><h4>cooldownWarningInterval</h4>
           <h6>Description</h6>
           <p>Interval in seconds for warning players about remaining cooldown time.</p>
           <h6>Default</h6>
           <pre><code>3</code></pre></li>
<li><h4>resetOnAttempt</h4>
           <h6>Description</h6>
           <p>If true, cooldown timer resets on each new attempt. If false, cooldown must expire before new attempts trigger rate limiting.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>squadWhitelist</h4>
           <h6>Description</h6>
           <p>Array of squad names that are always allowed, even during blocking periods. Names are matched case-insensitively.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordKillFeedExtended</summary>
          <h2>DiscordKillFeedExtended</h2>
          <p>The <code>DiscordKillFeedExtended</code> plugin posts wounds and kills to a Discord channel as one-line messages with Steam and BattleMetrics links, after a delay. It marks same-team hits and helicopter crashes, and can ping a role when a helicopter crashes.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log teamkills to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>messageDelay</h4>
           <h6>Description</h6>
           <p>Delay in milliseconds before each kill feed message is sent.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>helis</h4>
           <h6>Description</h6>
           <p>Helicopter weapon IDs. A wound or kill by one of these where the attacker is the victim is reported as a crash.</p>
           <h6>Default</h6>
           <pre><code>[
  "BP_MI8_VDV",
  "BP_UH1Y",
  "BP_UH60",
  "BP_UH1H_Desert",
  "BP_UH1H",
  "BP_CH178",
  "BP_MI8",
  "BP_CH146",
  "BP_MI17_MEA",
  "BP_Z8G",
  "BP_CH146_Desert",
  "BP_SA330",
  "BP_UH60_AUS",
  "BP_MRH90_Mag58",
  "BP_Z8J"
]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "BP_MI8_VDV"
]</code></pre>
<li><h4>heliCrashRoleID</h4>
           <h6>Description</h6>
           <p>Discord role ID to ping when a helicopter crash is reported. Leave empty for no ping.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre></ul>
        </details>

<details>
          <summary>SocketIOAPI</summary>
          <h2>SocketIOAPI</h2>
          <p>The <code>SocketIOAPI</code> plugin allows remote access to a SquadJS instance via Socket.IO<br />As a client example you can use this to connect to the socket.io server;<pre><code>
      const socket = io.connect('ws://IP:PORT', {
        auth: {
          token: "MySecretPassword"
        }
      })
    </code></pre>If you need more documentation about socket.io please go ahead and read the following;<br />General Socket.io documentation: <a href="https://socket.io/docs/v3" target="_blank">Socket.io Docs</a><br />Authentication and securing your websocket: <a href="https://socket.io/docs/v3/middlewares/#Sending-credentials" target="_blank">Sending-credentials</a><br />How to use, install and configure a socketIO-client: <a href="https://github.com/11TStudio/SocketIO-Examples-for-SquadJS" target="_blank">Usage Guide with Examples</a></p>
          <h3>Options</h3>
          <ul><li><h4>websocketPort (Required)</h4>
           <h6>Description</h6>
           <p>The port for the websocket.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>3000</code></pre>
<li><h4>securityToken (Required)</h4>
           <h6>Description</h6>
           <p>Your secret token/password for connecting.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>MySecretPassword</code></pre></ul>
        </details>

<details>
          <summary>AdminSync</summary>
          <h2>AdminSync</h2>
          <p>Syncs the Admins.cfg file with admin data from a whitelist URL at regular intervals.</p>
          <h3>Options</h3>
          <ul><li><h4>whitelistUrl (Required)</h4>
           <h6>Description</h6>
           <p>URL or array of URLs to fetch admin whitelist data from.</p>
           <h6>Default</h6>
           <pre><code>undefined</code></pre></li><h6>Example</h6>
           <pre><code>https://example.com/whitelist.txt or ["https://example.com/whitelist1.txt", "https://example.com/whitelist2.txt"]</code></pre>
<li><h4>adminsFilePath (Required)</h4>
           <h6>Description</h6>
           <p>Path to the Admins.cfg file.</p>
           <h6>Default</h6>
           <pre><code>undefined</code></pre></li><h6>Example</h6>
           <pre><code>/home/container/SquadGame/ServerConfig/Admins.cfg</code></pre>
<li><h4>temporaryReservesFilePath</h4>
           <h6>Description</h6>
           <p>Persistent temporary grants and last valid remote data. Defaults to adminsFilePath + .temporary-reserves.json.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li>
<li><h4>syncInterval</h4>
           <h6>Description</h6>
           <p>Interval in seconds between admin sync operations.</p>
           <h6>Default</h6>
           <pre><code>300</code></pre></li><h6>Example</h6>
           <pre><code>300</code></pre>
<li><h4>updateOnStartup</h4>
           <h6>Description</h6>
           <p>Whether to update the admin list when the plugin starts.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>chatCommands</h4>
           <h6>Description</h6>
           <p>Array of chat commands that will trigger an admin sync.</p>
           <h6>Default</h6>
           <pre><code>[
  "!syncadmins",
  "!updateadmins"
]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "!syncadmins",
  "!updateadmins"
]</code></pre>
<li><h4>beautifyOutput</h4>
           <h6>Description</h6>
           <p>Whether to beautify and organize the admin data with comments, statistics, and group sections.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>skipUnchanged</h4>
           <h6>Description</h6>
           <p>Whether to skip writing the file if the permissions of every admin ID are the same as at the last sync. Comments and group names are ignored.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>backupToDiscord</h4>
           <h6>Description</h6>
           <p>Whether to backup the Admins.cfg file to Discord after each successful sync.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>discordClient</h4>
           <h6>Description</h6>
           <p>Discord connector name (required if backupToDiscord is enabled).</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>backupChannelID</h4>
           <h6>Description</h6>
           <p>The ID of the Discord channel to send backup files to (required if backupToDiscord is enabled).</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre></ul>
        </details>

<details>
          <summary>CpuProfiler</summary>
          <h2>CpuProfiler</h2>
          <p>Diagnostics: logs the CPU use of the SquadJS process and the event loop utilization of the main thread, and writes CPU profiles of the main thread to disk.</p>
          <h3>Options</h3>
          <ul><li><h4>statsInterval</h4>
           <h6>Description</h6>
           <p>Milliseconds between CPU and event loop log lines.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>profileInterval</h4>
           <h6>Description</h6>
           <p>Milliseconds between the start of two CPU profiles. The first profile starts after one interval.</p>
           <h6>Default</h6>
           <pre><code>1200000</code></pre></li>
<li><h4>profileDuration</h4>
           <h6>Description</h6>
           <p>Length of one CPU profile in milliseconds.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>maxProfiles</h4>
           <h6>Description</h6>
           <p>Number of CPU profiles to write before profiling stops.</p>
           <h6>Default</h6>
           <pre><code>0</code></pre></li>
<li><h4>database</h4>
           <h6>Description</h6>
           <p>Sequelize connector whose queries are timed. Leave empty to skip query timing.</p>
           <h6>Default</h6>
           <pre><code>sqlite</code></pre></li>
<li><h4>slowQueryMs</h4>
           <h6>Description</h6>
           <p>Queries that take at least this many milliseconds are counted in the slow query summary.</p>
           <h6>Default</h6>
           <pre><code>200</code></pre></li>
<li><h4>outputDir</h4>
           <h6>Description</h6>
           <p>Folder for the .cpuprofile files, relative to the SquadJS folder.</p>
           <h6>Default</h6>
           <pre><code>cpu-profiles</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordRoundWinner</summary>
          <h2>DiscordRoundWinner</h2>
          <p>The <code>DiscordRoundWinner</code> plugin will send the round winner to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log admin broadcasts to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li></ul>
        </details>

<details>
          <summary>ParserHealthCheck</summary>
          <h2>ParserHealthCheck</h2>
          <p>The <code>ParserHealthCheck</code> plugin compares the data that SquadJS parses with other sources and warns when they disagree for several checks in a row. A Squad update that changes a log line or an RCON response usually makes SquadJS lose data without an error, and this plugin makes that visible.<ul><li>ListPlayers: parsed players against the ShowServerInfo player count.</li><li>ShowServerInfo: player count is not a number.</li><li>Log parser: no parsed log event for a set time while the server has players.</li><li>Log parser: new players in ListPlayers without a parsed connect line.</li><li>Layers: the current layer is not in the layer list.</li></ul></p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID</h4>
           <h6>Description</h6>
           <p>ID of the channel for warnings. When empty, warnings are only written to the log.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>checkInterval</h4>
           <h6>Description</h6>
           <p>Time between checks, in milliseconds.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>consecutiveChecks</h4>
           <h6>Description</h6>
           <p>Number of failed checks in a row before a warning is sent.</p>
           <h6>Default</h6>
           <pre><code>3</code></pre></li>
<li><h4>minimumPlayers</h4>
           <h6>Description</h6>
           <p>The ListPlayers and log activity checks run only when ShowServerInfo reports at least this many players.</p>
           <h6>Default</h6>
           <pre><code>10</code></pre></li>
<li><h4>logActivityTimeout</h4>
           <h6>Description</h6>
           <p>Time without any parsed log event before the log activity check fails, in milliseconds. Squad can stop writing tick rate lines for 40 minutes or more, so all log events are counted.</p>
           <h6>Default</h6>
           <pre><code>900000</code></pre></li>
<li><h4>connectGracePeriod</h4>
           <h6>Description</h6>
           <p>Time a new player may be in ListPlayers without a parsed connect line, in milliseconds.</p>
           <h6>Default</h6>
           <pre><code>120000</code></pre></li>
<li><h4>minimumPlayersWithoutConnect</h4>
           <h6>Description</h6>
           <p>Number of new players without a parsed connect line before the check fails.</p>
           <h6>Default</h6>
           <pre><code>3</code></pre></li>
<li><h4>checkCurrentLayer</h4>
           <h6>Description</h6>
           <p>Warn when the current layer is not in the SquadJS layer list. Turn this off when the layer list is known to be out of date for the current Squad version.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordAdminBroadcast</summary>
          <h2>DiscordAdminBroadcast</h2>
          <p>The <code>DiscordAdminBroadcast</code> plugin will send a copy of admin broadcasts made in game to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log admin broadcasts to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li></ul>
        </details>

<details>
          <summary>IntervalledBroadcasts</summary>
          <h2>IntervalledBroadcasts</h2>
          <p>The <code>IntervalledBroadcasts</code> plugin allows you to set broadcasts, which will be broadcasted at preset intervals</p>
          <h3>Options</h3>
          <ul><li><h4>broadcasts</h4>
           <h6>Description</h6>
           <p>Messages to broadcast.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "This server is powered by SquadJS."
]</code></pre>
<li><h4>interval</h4>
           <h6>Description</h6>
           <p>Frequency of the broadcasts in milliseconds.</p>
           <h6>Default</h6>
           <pre><code>300000</code></pre></li></ul>
        </details>

<details>
          <summary>LookingForSquad</summary>
          <h2>LookingForSquad</h2>
          <p>The <code>LookingForSquad</code> plugin allows players to request invites to locked squads via chat commands. Supports targeting specific squads or players, with spam protection and detailed validation.</p>
          <h3>Options</h3>
          <ul><li><h4>commands</h4>
           <h6>Description</h6>
           <p>Commands that trigger the invite system.</p>
           <h6>Default</h6>
           <pre><code>[
  "!inv",
  "!invite",
  "!lfs"
]</code></pre></li>
<li><h4>cooldownSeconds</h4>
           <h6>Description</h6>
           <p>Number of seconds that must pass before the same user can send another invite request.</p>
           <h6>Default</h6>
           <pre><code>10</code></pre></li>
<li><h4>maxSquadSize</h4>
           <h6>Description</h6>
           <p>Maximum squad size (squads at this size are considered full).</p>
           <h6>Default</h6>
           <pre><code>9</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordSquadCreated</summary>
          <h2>DiscordSquadCreated</h2>
          <p>The <code>SquadCreated</code> plugin will log Squad Creation events to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log Squad Creation events to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>useEmbed</h4>
           <h6>Description</h6>
           <p>Send message as Embed</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordAltChecker</summary>
          <h2>DiscordAltChecker</h2>
          <p>The <code>DiscordAltChecker</code> plugin detects potential alt accounts by matching a joining player's IP against historical IPs stored by DBLog. Sends a pinged alert to Discord and warns in-game admins when the shared IP belongs to a player currently online. Sends a quiet log when the match is an offline player only. Admins can also manually look up any player via <code>!alt &lt;name|steamID|eosID|IP&gt;</code> in admin chat or in the configured Discord command channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>alertChannelID (Required)</h4>
           <h6>Description</h6>
           <p>Channel ID for active in-game IP collision alerts (with role pings).</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>logChannelID (Required)</h4>
           <h6>Description</h6>
           <p>Channel ID for historical offline IP match logs (no pings).</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136460</code></pre>
<li><h4>commandChannelID (Required)</h4>
           <h6>Description</h6>
           <p>Channel ID where admins can run !alt lookups. Bot listens and replies in this channel.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136461</code></pre>
<li><h4>command</h4>
           <h6>Description</h6>
           <p>The in-game and Discord command prefix (without !).</p>
           <h6>Default</h6>
           <pre><code>alt</code></pre></li>
<li><h4>pingGroups</h4>
           <h6>Description</h6>
           <p>Array of Discord role IDs to ping when an active collision is detected.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "500455137626554379"
]</code></pre>
<li><h4>pingHere</h4>
           <h6>Description</h6>
           <p>Whether to also include @here in alert pings.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>database (Required)</h4>
           <h6>Description</h6>
           <p>Sequelize connector. Requires DBLog to be running so DBLog_Players is populated.</p>
           <h6>Default</h6>
           <pre><code>sqlite</code></pre></li></ul>
        </details>

<details>
          <summary>AutoKickUnassigned</summary>
          <h2>AutoKickUnassigned</h2>
          <p>The <code>AutoKickUnassigned</code> plugin will automatically kick players that are not in a squad after a specified ammount of time.</p>
          <h3>Options</h3>
          <ul><li><h4>warningMessage</h4>
           <h6>Description</h6>
           <p>Message SquadJS will send to players warning them they will be kicked</p>
           <h6>Default</h6>
           <pre><code>Join a squad, you are unassigned and will be kicked</code></pre></li>
<li><h4>kickMessage</h4>
           <h6>Description</h6>
           <p>Message to send to players when they are kicked</p>
           <h6>Default</h6>
           <pre><code>Unassigned - automatically removed</code></pre></li>
<li><h4>frequencyOfWarnings</h4>
           <h6>Description</h6>
           <p>How often in <b>Seconds</b> should we warn the player about being unassigned?</p>
           <h6>Default</h6>
           <pre><code>30</code></pre></li>
<li><h4>unassignedTimer</h4>
           <h6>Description</h6>
           <p>How long in <b>Seconds</b> to wait before a unassigned player is kicked</p>
           <h6>Default</h6>
           <pre><code>360</code></pre></li>
<li><h4>playerThreshold</h4>
           <h6>Description</h6>
           <p>Player count required for AutoKick to start kicking players, set to -1 to disable</p>
           <h6>Default</h6>
           <pre><code>93</code></pre></li>
<li><h4>roundStartDelay</h4>
           <h6>Description</h6>
           <p>Time delay in <b>Seconds</b> from start of the round before AutoKick starts kicking again</p>
           <h6>Default</h6>
           <pre><code>900</code></pre></li>
<li><h4>ignoreAdmins</h4>
           <h6>Description</h6>
           <p><ul><li><code>true</code>: Admins will <b>NOT</b> be kicked</li><li><code>false</code>: Admins <b>WILL</b> be kicked</li></ul></p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>ignoreWhitelist</h4>
           <h6>Description</h6>
           <p><ul><li><code>true</code>: Reserve slot players will <b>NOT</b> be kicked</li><li><code>false</code>: Reserve slot players <b>WILL</b> be kicked</li></ul></p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordDebug</summary>
          <h2>DiscordDebug</h2>
          <p>The <code>DiscordDebug</code> plugin can be used to help debug SquadJS by dumping SquadJS events to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log events to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>events (Required)</h4>
           <h6>Description</h6>
           <p>A list of events to dump.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "PLAYER_DIED"
]</code></pre></ul>
        </details>

<details>
          <summary>AutoTKWarn</summary>
          <h2>AutoTKWarn</h2>
          <p>The <code>AutoTkWarn</code> plugin will automatically warn players with a message when they teamkill.</p>
          <h3>Options</h3>
          <ul><li><h4>attackerMessage</h4>
           <h6>Description</h6>
           <p>The message to warn attacking players with.</p>
           <h6>Default</h6>
           <pre><code>Please apologise for ALL TKs in ALL chat!</code></pre></li>
<li><h4>victimMessage</h4>
           <h6>Description</h6>
           <p>The message that will be sent to the victim.</p>
           <h6>Default</h6>
           <pre><code>null</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordReloadConfig</summary>
          <h2>DiscordReloadConfig</h2>
          <p>The <code>DiscordReloadConfig</code> plugin allows authorized Discord users to activate whitelist and configuration changes by sending <code>!activate</code> in a specified Discord channel or its threads. Typically used after adding players to the priority queue following donations.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>ID of channel where the activate command can be used. Also works in threads within this channel. Ignored if allowAnyChannel is true.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>allowAnyChannel</h4>
           <h6>Description</h6>
           <p>Whether to allow the activate command in any channel/thread. When true, channelID restriction is bypassed.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li><h6>Example</h6>
           <pre><code>true</code></pre>
<li><h4>permissions</h4>
           <h6>Description</h6>
           <p>List of Discord role IDs that are allowed to use the activate command. If empty, all users can use it.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "123456789123456789",
  "987654321987654321"
]</code></pre>
<li><h4>embedImageURL</h4>
           <h6>Description</h6>
           <p>Image URL shown in the confirmation embed. Leave empty for no image. Use a permanent URL, because Discord attachment links expire.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li></ul>
        </details>

<details>
          <summary>CBLInfo</summary>
          <h2>CBLInfo</h2>
          <p>The <code>CBLInfo</code> plugin alerts admins when a harmful player is detected joining their server based on data from the <a href="https://communitybanlist.com/">Community Ban List</a>.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to alert admins through.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>threshold</h4>
           <h6>Description</h6>
           <p>Admins will be alerted when a player has this or more reputation points. For more information on reputation points, see the <a href="https://communitybanlist.com/faq">Community Ban List's FAQ</a></p>
           <h6>Default</h6>
           <pre><code>6</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordChat</summary>
          <h2>DiscordChat</h2>
          <p>The <code>DiscordChat</code> plugin will log in-game chat to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log admin broadcasts to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>chatColors</h4>
           <h6>Description</h6>
           <p>The color of the embed for each chat.</p>
           <h6>Default</h6>
           <pre><code>{}</code></pre></li><h6>Example</h6>
           <pre><code>{
  "ChatAll": 16761867
}</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>ignoreChats</h4>
           <h6>Description</h6>
           <p>A list of chat names to ignore.</p>
           <h6>Default</h6>
           <pre><code>[
  "ChatSquad"
]</code></pre></li></ul>
        </details>

<details>
          <summary>SeedingMode</summary>
          <h2>SeedingMode</h2>
          <p>The <code>SeedingMode</code> plugin broadcasts seeding rule messages to players at regular intervals when the server is below a specified player count. It can also be configured to display "Live" messages when the server goes live.</p>
          <h3>Options</h3>
          <ul><li><h4>interval</h4>
           <h6>Description</h6>
           <p>Frequency of seeding messages in milliseconds.</p>
           <h6>Default</h6>
           <pre><code>150000</code></pre></li>
<li><h4>seedingThreshold</h4>
           <h6>Description</h6>
           <p>Player count required for server not to be in seeding mode.</p>
           <h6>Default</h6>
           <pre><code>50</code></pre></li>
<li><h4>seedingMessage</h4>
           <h6>Description</h6>
           <p>Seeding message to display.</p>
           <h6>Default</h6>
           <pre><code>Seeding Rules Active! Fight only over the middle flags! No FOB Hunting!</code></pre></li>
<li><h4>liveEnabled</h4>
           <h6>Description</h6>
           <p>Enable "Live" messages for when the server goes live.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>liveThreshold</h4>
           <h6>Description</h6>
           <p>Player count required for "Live" messages to not bee displayed.</p>
           <h6>Default</h6>
           <pre><code>52</code></pre></li>
<li><h4>liveMessage</h4>
           <h6>Description</h6>
           <p>"Live" message to display.</p>
           <h6>Default</h6>
           <pre><code>Live!</code></pre></li>
<li><h4>waitOnNewGames</h4>
           <h6>Description</h6>
           <p>Should the plugin wait to be executed on NEW_GAME event.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>waitTimeOnNewGame</h4>
           <h6>Description</h6>
           <p>The time to wait before check player counts in seconds.</p>
           <h6>Default</h6>
           <pre><code>30</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordRcon</summary>
          <h2>DiscordRcon</h2>
          <p>The <code>DiscordRcon</code> plugin allows a specified Discord channel to be used as a RCON console to run RCON commands.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>ID of channel to turn into RCON console.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>permissions</h4>
           <h6>Description</h6>
           <p><ul><li>Dictionary of roles and a list of the permissions they are allowed to use.<li>If dictionary is empty (<code>{}</code>) permissions will be disabled</li><li>A list of available RCON commands can be found here <a>https://squad.gamepedia.com/Server_Administration#Admin_Console_Commands</a>.</ul></p>
           <h6>Default</h6>
           <pre><code>{}</code></pre></li><h6>Example</h6>
           <pre><code>{
  "123456789123456789": [
    "AdminBroadcast",
    "AdminForceTeamChange",
    "AdminDemoteCommander"
  ]
}</code></pre>
<li><h4>prependAdminNameInBroadcast</h4>
           <h6>Description</h6>
           <p>Prepend admin names when making announcements.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>AdminBroadcastCommands</summary>
          <h2>AdminBroadcastCommands</h2>
          <p>Handles admin chat commands for broadcasting preset messages with support for aliases, partial matching, and delay mode. The broadcasts can be kept in a Discord forum channel: one post per broadcast, the post title is <code>Name | alias1, alias2</code>, and the broadcast text is the newest reply that starts with <code>!set</code>, or else the first message of the post. Other replies are discussion. The pinned post is skipped, so it can hold instructions. Changes apply without a restart.</p>
          <h3>Options</h3>
          <ul><li><h4>commandPrefixes</h4>
           <h6>Description</h6>
           <p>A list of prefixes used for the broadcast command.</p>
           <h6>Default</h6>
           <pre><code>[
  "!broadcast",
  "!bc"
]</code></pre></li>
<li><h4>delayMode</h4>
           <h6>Description</h6>
           <p>Whether to use delay mode when sending multiple messages.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>delayBetweenMessages</h4>
           <h6>Description</h6>
           <p>The delay in milliseconds between messages in delay mode.</p>
           <h6>Default</h6>
           <pre><code>5000</code></pre></li>
<li><h4>showAliasesInList</h4>
           <h6>Description</h6>
           <p>Whether to show aliases in the broadcast options list.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>multipartMessagePrefix</h4>
           <h6>Description</h6>
           <p>Prefix to add to continuation messages when splitting long broadcasts.</p>
           <h6>Default</h6>
           <pre><code>(cont.) </code></pre></li>
<li><h4>broadcasts</h4>
           <h6>Description</h6>
           <p>An array of broadcast options with name, aliases, and message. With a forum channel, these are used until the forum is loaded, and to create the first posts when the forum is empty.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li>
<li><h4>discordClient</h4>
           <h6>Description</h6>
           <p>Discord connector name. Needed only for a forum channel.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>forumChannelID</h4>
           <h6>Description</h6>
           <p>ID of the Discord forum channel with the broadcasts. Leave empty to use only the config.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li>
<li><h4>editorRoleIDs</h4>
           <h6>Description</h6>
           <p>Role IDs whose messages count as broadcast text. Leave empty to accept every message that the channel permissions allow.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li>
<li><h4>order</h4>
           <h6>Description</h6>
           <p>Order of the forum broadcasts in the list: "created" (oldest post first, new posts are added at the end) or "name".</p>
           <h6>Default</h6>
           <pre><code>created</code></pre></li>
<li><h4>seedForumFromConfig</h4>
           <h6>Description</h6>
           <p>When the forum has no posts, create one post per configured broadcast.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>reloadInterval</h4>
           <h6>Description</h6>
           <p>Time between full reloads of the forum, in milliseconds. Edits of older messages are not always reported by Discord, so they are picked up by this reload.</p>
           <h6>Default</h6>
           <pre><code>600000</code></pre></li>
<li><h4>stateFile</h4>
           <h6>Description</h6>
           <p>File for the last list loaded from the forum, used when Discord is not available at startup.</p>
           <h6>Default</h6>
           <pre><code>./admin-broadcast-commands-state.json</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordAdminCamLogs</summary>
          <h2>DiscordAdminCamLogs</h2>
          <p>The <code>DiscordAdminCamLogs</code> plugin will log in game admin camera usage to a Discord channel.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log admin camera usage to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li></ul>
        </details>

<details>
          <summary>RconRecorder</summary>
          <h2>RconRecorder</h2>
          <p>The <code>RconRecorder</code> plugin records every RCON command that SquadJS sends with its response, the messages the server pushes over RCON, and optionally every game log line that SquadJS reads. It writes one JSON line per entry into one file per UTC hour, compresses finished hours with gzip, and deletes old files by age and total size. A response that equals the previous response of the same command is written as <code>"same": true</code>. It sends no extra RCON commands.</p>
          <h3>Options</h3>
          <ul><li><h4>directory</h4>
           <h6>Description</h6>
           <p>Directory for the recordings, relative to the SquadJS directory.</p>
           <h6>Default</h6>
           <pre><code>./rcon-recordings</code></pre></li>
<li><h4>recordLogLines</h4>
           <h6>Description</h6>
           <p>Also record every game log line that SquadJS reads.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>retentionDays</h4>
           <h6>Description</h6>
           <p>Files older than this number of days are deleted.</p>
           <h6>Default</h6>
           <pre><code>14</code></pre></li>
<li><h4>maxTotalMB</h4>
           <h6>Description</h6>
           <p>Maximum total size of all recordings in MB. The oldest files are deleted first.</p>
           <h6>Default</h6>
           <pre><code>1024</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordServerStatusExtended</summary>
          <h2>DiscordServerStatusExtended</h2>
          <p>The <code>DiscordServerStatusExtended</code> plugin works like <code>DiscordServerStatus</code>. When the current layer is unknown, the bot status uses the layer that RCON reports.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>messageStore (Required)</h4>
           <h6>Description</h6>
           <p>Sequelize connector name.</p>
           <h6>Default</h6>
           <pre><code>sqlite</code></pre></li>
<li><h4>command</h4>
           <h6>Description</h6>
           <p>Command name to get message.</p>
           <h6>Default</h6>
           <pre><code>!status</code></pre></li>
<li><h4>disableSubscriptions</h4>
           <h6>Description</h6>
           <p>Whether to allow messages to be subscribed to automatic updates.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>updateInterval</h4>
           <h6>Description</h6>
           <p>How frequently to update the time in Discord.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>setBotStatus</h4>
           <h6>Description</h6>
           <p>Whether to update the bot's status with server information.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li></ul>
        </details>

<details>
          <summary>SquadBalancer</summary>
          <h2>SquadBalancer</h2>
          <p>Balances teams by swapping squads intelligently based on consecutive wins and per-player performance delta, preserving squad integrity.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the Discord channel to log squad balancing events to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed for Discord logging.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>database (Required)</h4>
           <h6>Description</h6>
           <p>The Sequelize connector to access game stats.</p>
           <h6>Default</h6>
           <pre><code>mysql</code></pre></li>
<li><h4>dryRun</h4>
           <h6>Description</h6>
           <p>When enabled, runs the full decision pipeline and sends a preview embed to Discord but skips all team-switch RCON actions.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>testMode</h4>
           <h6>Description</h6>
           <p>Deprecated alias for dryRun. Use dryRun instead.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>consecutiveWinsThreshold</h4>
           <h6>Description</h6>
           <p>Number of consecutive round wins before triggering reshuffle.</p>
           <h6>Default</h6>
           <pre><code>3</code></pre></li>
<li><h4>shuffleDelaySeconds</h4>
           <h6>Description</h6>
           <p>Delay in seconds after round end before performing the reshuffle.</p>
           <h6>Default</h6>
           <pre><code>15</code></pre></li>
<li><h4>showBroadcasts</h4>
           <h6>Description</h6>
           <p>Whether to broadcast messages about the reshuffling action.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>considerTicketDifference</h4>
           <h6>Description</h6>
           <p>Whether to require a minimum ticket difference to count a round win.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>ticketDifferenceThreshold</h4>
           <h6>Description</h6>
           <p>Ticket difference threshold for non-invasion layers to count as a valid win.</p>
           <h6>Default</h6>
           <pre><code>200</code></pre></li>
<li><h4>invasionTicketDifferenceThreshold</h4>
           <h6>Description</h6>
           <p>Ticket difference threshold for invasion layers to count as a valid win.</p>
           <h6>Default</h6>
           <pre><code>700</code></pre></li>
<li><h4>excludedLayers</h4>
           <h6>Description</h6>
           <p>An array of layer identifiers to exclude. If the winner's layer includes any of these (case insensitive), the round will be skipped.</p>
           <h6>Default</h6>
           <pre><code>[
  "seed",
  "jensen"
]</code></pre></li>
<li><h4>killWeight</h4>
           <h6>Description</h6>
           <p>Weight factor for kills in performance calculation.</p>
           <h6>Default</h6>
           <pre><code>1</code></pre></li>
<li><h4>reviveWeight</h4>
           <h6>Description</h6>
           <p>Weight factor for revives in performance calculation.</p>
           <h6>Default</h6>
           <pre><code>1</code></pre></li>
<li><h4>teamkillWeight</h4>
           <h6>Description</h6>
           <p>Weight factor for teamkills in performance calculation (negative reduces score).</p>
           <h6>Default</h6>
           <pre><code>-2</code></pre></li>
<li><h4>moveCoefficient</h4>
           <h6>Description</h6>
           <p>Fraction of the smaller team to move per unit of relative per-player score delta, where the delta is expressed as a share of the match average. At 0.35 a winner scoring twice the loser's rate moves about a third of the smaller team. Higher = more aggressive redistribution.</p>
           <h6>Default</h6>
           <pre><code>0.35</code></pre></li>
<li><h4>maxMoveFraction</h4>
           <h6>Description</h6>
           <p>Hard cap on the fraction of the smaller team that can be moved in a single swap.</p>
           <h6>Default</h6>
           <pre><code>0.35</code></pre></li>
<li><h4>minMoveSize</h4>
           <h6>Description</h6>
           <p>Minimum number of players to move when a swap is triggered.</p>
           <h6>Default</h6>
           <pre><code>1</code></pre></li>
<li><h4>autoBalanceMaxMoves</h4>
           <h6>Description</h6>
           <p>Hard cap on how many players the follow-up auto-balancer may move. The reshuffle it runs after is designed to end roughly even, so a large correction means the roster read is wrong rather than the teams being lopsided.</p>
           <h6>Default</h6>
           <pre><code>8</code></pre></li>
<li><h4>satScoresDir</h4>
           <h6>Description</h6>
           <p>Local path to the SAT PlayerScores directory (e.g. C:/SquadGame/Saved/SquadAdminTools/PlayerScores). When set and files exist, this is the primary scoring source. Falls back to DBLog if the directory is missing or contains no files.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li>
<li><h4>satFileRetainCount</h4>
           <h6>Description</h6>
           <p>Number of SAT PlayerScores files to keep. The most recent N files are retained; older ones are deleted automatically after each scored round.</p>
           <h6>Default</h6>
           <pre><code>6</code></pre></li></ul>
        </details>

<details>
          <summary>LayerRotationManager</summary>
          <h2>LayerRotationManager</h2>
          <p>Comments out layers in LayerVoting.cfg if the current game mode has been played recently.</p>
          <h3>Options</h3>
          <ul><li><h4>layerVotingFilePath (Required)</h4>
           <h6>Description</h6>
           <p>Path to the LayerVoting.cfg file.</p>
           <h6>Default</h6>
           <pre><code>/SquadGame/ServerConfig/LayerVoting.cfg</code></pre></li><h6>Example</h6>
           <pre><code>/SquadGame/ServerConfig/LayerVoting.cfg</code></pre>
<li><h4>gameModeSkipRounds</h4>
           <h6>Description</h6>
           <p>JSON object defining how many rounds to skip for each game mode.</p>
           <h6>Default</h6>
           <pre><code>{
  "AAS": 0,
  "RAAS": 0,
  "Invasion": 3,
  "Seed": 0,
  "Skirmish": 0,
  "TerritoryControl": 0,
  "Insurgency": 3,
  "Destruction": 3
}</code></pre></li><h6>Example</h6>
           <pre><code>{
  "AAS": 0,
  "RAAS": 0,
  "Invasion": 3,
  "Seed": 0,
  "Skirmish": 0,
  "TerritoryControl": 0,
  "Insurgency": 3,
  "Destruction": 3
}</code></pre>
<li><h4>alwaysDisabledGameModes</h4>
           <h6>Description</h6>
           <p>Array of game modes to always keep commented out.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "TerritoryControl",
  "Seed"
]</code></pre>
<li><h4>alwaysEnabledGameModes</h4>
           <h6>Description</h6>
           <p>Array of game modes to always keep enabled, overriding rotation rules but not alwaysDisabledLayers/Levels.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "RAAS",
  "AAS"
]</code></pre>
<li><h4>alwaysDisabledLevels</h4>
           <h6>Description</h6>
           <p>Array of level/map names to always keep commented out.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "Fallujah",
  "Logar"
]</code></pre>
<li><h4>alwaysEnabledLevels</h4>
           <h6>Description</h6>
           <p>Array of level/map names to always keep enabled, overriding other disable rules except for alwaysDisabledLayers.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "Yehorivka",
  "Goose"
]</code></pre>
<li><h4>alwaysDisabledLayers</h4>
           <h6>Description</h6>
           <p>Array of specific layer names to always keep commented out, regardless of game mode rotation.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "ICM_AlBasrah_Invasion_v1",
  "ICM_Anvil_AAS_v2"
]</code></pre>
<li><h4>alwaysEnabledLayers</h4>
           <h6>Description</h6>
           <p>Array of specific layer names to always keep enabled, overriding any other disable rules.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "ICM_Fallujah_TC_v1",
  "ICM_Logar_RAAS_v1"
]</code></pre>
<li><h4>gameModeIdentifiers</h4>
           <h6>Description</h6>
           <p>Mapping of game mode identifiers in layer names.</p>
           <h6>Default</h6>
           <pre><code>{
  "AAS": "_AAS_",
  "RAAS": "_RAAS_",
  "Invasion": "_Invasion_",
  "Seed": "_Seed_",
  "Skirmish": "_Skirmish_",
  "TerritoryControl": "_TC_",
  "Insurgency": "_Insurgency_",
  "Destruction": "_Destruction_",
  "KingOfTheHill": "_KOTH_",
  "Siege": "_Siege_",
  "Armor": "_Armor_",
  "Tanks": "_Tanks_",
  "Sandbox": "_Sandbox_",
  "PAAS": "_PAAS_"
}</code></pre></li>
<li><h4>debugMode</h4>
           <h6>Description</h6>
           <p>Enable additional debug logging.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>disableModesInSeedMode</h4>
           <h6>Description</h6>
           <p>Array of game modes to comment out when the current layer is Seed mode.</p>
           <h6>Default</h6>
           <pre><code>[
  "Invasion"
]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "Invasion",
  "Insurgency",
  "Destruction"
]</code></pre>
<li><h4>timezone</h4>
           <h6>Description</h6>
           <p>IANA timezone identifier for time-based rules (e.g., "America/New_York", "Europe/London", "UTC").</p>
           <h6>Default</h6>
           <pre><code>UTC</code></pre></li><h6>Example</h6>
           <pre><code>America/New_York</code></pre>
<li><h4>timeBasedDisabledGameModes</h4>
           <h6>Description</h6>
           <p>Object mapping game mode names to time windows when they should be disabled. Uses 24-hour format. Supports overnight ranges (e.g., startHour: 22, endHour: 6).</p>
           <h6>Default</h6>
           <pre><code>{}</code></pre></li><h6>Example</h6>
           <pre><code>{
  "Invasion": {
    "startHour": 22,
    "endHour": 6
  }
}</code></pre></ul>
        </details>

<details>
          <summary>DiscordTeamkill</summary>
          <h2>DiscordTeamkill</h2>
          <p>The <code>DiscordTeamkill</code> plugin logs teamkills and related information to a Discord channel for admins to review.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log teamkills to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embeds.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>disableCBL</h4>
           <h6>Description</h6>
           <p>Disable Community Ban List information.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordAdminRequest</summary>
          <h2>DiscordAdminRequest</h2>
          <p>The <code>DiscordAdminRequest</code> plugin will ping admins in a Discord channel when a player requests an admin via the <code>!admin</code> command in in-game chat.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log admin broadcasts to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>ignoreChats</h4>
           <h6>Description</h6>
           <p>A list of chat names to ignore.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "ChatSquad"
]</code></pre>
<li><h4>ignorePhrases</h4>
           <h6>Description</h6>
           <p>A list of phrases to ignore.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "switch"
]</code></pre>
<li><h4>command</h4>
           <h6>Description</h6>
           <p>The command that calls an admin.</p>
           <h6>Default</h6>
           <pre><code>admin</code></pre></li>
<li><h4>pingGroups</h4>
           <h6>Description</h6>
           <p>A list of Discord role IDs to ping.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "500455137626554379"
]</code></pre>
<li><h4>pingHere</h4>
           <h6>Description</h6>
           <p>Ping @here. Great if Admin Requests are posted to a Squad Admin ONLY channel, allows pinging only Online Admins.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>pingDelay</h4>
           <h6>Description</h6>
           <p>Cooldown for pings in milliseconds.</p>
           <h6>Default</h6>
           <pre><code>60000</code></pre></li>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>warnInGameAdmins</h4>
           <h6>Description</h6>
           <p>Should in-game admins be warned after a players uses the command and should we tell how much admins are active in-game right now.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>showInGameAdmins</h4>
           <h6>Description</h6>
           <p>Should players know how much in-game admins there are active/online?</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordAdminCamLogsExtended</summary>
          <h2>DiscordAdminCamLogsExtended</h2>
          <p>The <code>DiscordAdminCamLogsExtended</code> plugin logs in-game admin camera usage to a Discord channel, counts entries per match, pings roles for short or frequent sessions, and warns in-game admins.</p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>channelID (Required)</h4>
           <h6>Description</h6>
           <p>The ID of the channel to log admin camera usage to.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre>
<li><h4>color</h4>
           <h6>Description</h6>
           <p>The color of the embed.</p>
           <h6>Default</h6>
           <pre><code>16761867</code></pre></li>
<li><h4>useEmbeds</h4>
           <h6>Description</h6>
           <p>Whether to use Discord embeds for messages or plain text.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>notifyRoles</h4>
           <h6>Description</h6>
           <p>Array of Discord role IDs to ping if admin cam time is below threshold.</p>
           <h6>Default</h6>
           <pre><code>[]</code></pre></li><h6>Example</h6>
           <pre><code>[
  "667741905228136459",
  "667741905228136460"
]</code></pre>
<li><h4>notifyHere</h4>
           <h6>Description</h6>
           <p>Whether to ping @here if admin cam time is below threshold.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li>
<li><h4>notifyThreshold</h4>
           <h6>Description</h6>
           <p>Time threshold in seconds. If an admin cam session is shorter, notifications are sent. Not applied on seeding layers.</p>
           <h6>Default</h6>
           <pre><code>120</code></pre></li>
<li><h4>notifyEntryCountThreshold</h4>
           <h6>Description</h6>
           <p>Entry count threshold. If an admin enters admin cam this many times in one match, notifications are sent.</p>
           <h6>Default</h6>
           <pre><code>5</code></pre></li>
<li><h4>warnInGameAdmins</h4>
           <h6>Description</h6>
           <p>Warn in game admins when an admin enters or leaves admin cam.</p>
           <h6>Default</h6>
           <pre><code>true</code></pre></li>
<li><h4>removePlayerFromSquad</h4>
           <h6>Description</h6>
           <p>Remove the player from their squad when they enter admin cam.</p>
           <h6>Default</h6>
           <pre><code>false</code></pre></li></ul>
        </details>

<details>
          <summary>DiscordSubsystemRestarter</summary>
          <h2>DiscordSubsystemRestarter</h2>
          <p>The <code>DiscordSubSystemRestarter</code> plugin allows you to manually restart SquadJS subsystems in case an issues arises with them.<ul><li><code>!squadjs restartsubsystem rcon</code></li><li><code>!squadjs restartsubsystem logparser</code></li></ul></p>
          <h3>Options</h3>
          <ul><li><h4>discordClient (Required)</h4>
           <h6>Description</h6>
           <p>Discord connector name.</p>
           <h6>Default</h6>
           <pre><code>discord</code></pre></li>
<li><h4>role (Required)</h4>
           <h6>Description</h6>
           <p>ID of role required to run the sub system restart commands.</p>
           <h6>Default</h6>
           <pre><code></code></pre></li><h6>Example</h6>
           <pre><code>667741905228136459</code></pre></ul>
        </details>

<br>

## Statement on Accuracy
Some information SquadJS collects from Squad servers was never intended or designed to be collected. As a result, it is impossible for any framework to collect the same information with 100% accuracy. SquadJS aims to get as close as possible to that figure, however, it acknowledges that this is not possible in some specific scenarios.

Below is a list of scenarios we know may cause some information to be inaccurate:
* Use of Realtime Server and Player Information - We update server and player information periodically every 30 seconds (by default) or when we know that it requires an update. As a result, some information about the server or players may be up to 30 seconds out of date or greater if an error occurs whilst updating this information.
* SquadJS Restarts - If SquadJS is started during an active Squad game some information will be lost or not collected correctly:
    - The current state of players will be lost. For example, if a player was wounded prior to the bot starting and then is revived/gives up after the bot is started information regarding who originally wounded them will not be known.
    - The accurate collection of some server log events will not occur. SquadJS collects players' "suffix" name, i.e. their Steam name without the clan tag added via the game settings, when they join the server and uses this to identify them in certain logs that do not include their full name. As a result, for players connecting prior to SquadJS starting some log events associated with their actions will show the player as `null`.
* Duplicated Player Names - If two or more players have the same name or suffix name (see above) then SquadJS will be unable to identify them in the logs. When this occurs event logs will show the player as `null`. Be on the watch for groups of players who try to abuse this in order to TK or complete other malicious actions without being detected by SquadJS plugins.

## SquadJS API
SquadJS pings the following data to the [SquadJS API](https://github.com/Team-Silver-Sphere/SquadJS-API/) at regular intervals to assist with its development:
* Squad server IP, query port, name & player count (including queue size).
* SquadJS version.
* Log reader mode, i.e. `tail` or `ftp`.
* Plugin configuration.

At this time, this cannot be disabled.

Please note, plugin configurations do **not** and should **not** contain any sensitive information which allows us to collect this information. Any sensitive information, e.g. Discord login tokens, should be included in the `connectors` section of the config which is not sent to our API. It is important that developers of custom plugins maintain this approach to avoid submitting confidential information to our API.

## Versions and Releases
Whilst installing SquadJS you may do the following to obtain slightly different versions:
* Download the [latest release](https://github.com/Team-Silver-Sphere/SquadJS/releases/latest) - To get the latest **stable** version of SquadJS.
* Download/clone the [`master` branch](https://github.com/Team-Silver-Sphere/SquadJS/) - To get the most up to date version of SquadJS.

All changes proposed to SquadJS will be merged into the `master` branch prior to being released in the next stable version to allow for a period of larger-scale testing to occur. Therefore, we only recommend individuals who are willing to update regularly and partake in testing/bug reporting use the `master` branch. Please note, updates to the `master` branch will not be advertised in the SquadJS startup information, however, notifications of merged pull requests into the `master` branch may be found in our [Discord](https://discord.gg/9F2Ng5C). Once the `master` branch is deemed stable a release will be published and advertised via the SquadJS startup information and our [Discord](https://discord.gg/9F2Ng5C).

Releases will be given a version number with the format `v{major}.{minor}.{patch}`, e.g. `v3.1.4`. Changes to `{major}`/`{minor}`/`{patch}` will imply the following:
* `{major}` - The release contains a new/updated feature that is (potentially) breaking, e.g. changes to event outputs that may cause custom plugins to break.
* `{minor}` - The release contains a new/updated feature.
* `{patch}` - The release contains a bug fix.

Please note, `{minor}`/`{patch}` releases may still break SquadJS installations, however, this may be prevented with configuration changes and should not require custom plugins to be updated.

Release version numbers and changelogs are managed by [Release Drafter](https://github.com/marketplace/actions/release-drafter) which relies on the appropriate labels being applied to pull requests. Version numbers are updated in the `package.json` file manually prior to publishing the release draft.

The above policy was written and put into effect after the release of SquadJS v2.0.5. A major version bump to SquadJS v3.0.0 was made to signify this policy taking affect and to draw a line under the previous poor management of releases and version numbers.

## Credits
SquadJS would not be possible without the support of so many individuals and organisations. Our thanks goes out to:
* [SquadJS's contributors](https://github.com/Team-Silver-Sphere/SquadJS/graphs/contributors).
* [Thomas Smyth's GitHub sponsors](https://github.com/sponsors/Thomas-Smyth).
* subtlerod for proposing the initial log parsing idea, helping to design the log parsing process and for providing multiple servers to test with.
* Shanomac99 and the rest of the Squad Wiki team for providing us with [layer information](https://github.com/Squad-Wiki-Editorial/squad-wiki-pipeline-map-data).
* Fourleaf, Mex, various members of ToG / ToG-L and others that helped to stage logs and participate in small scale tests.
* Various Squad servers/communities for participating in larger scale tests and for providing feedback on plugins.
* Everyone in the [Squad RCON Discord](https://discord.gg/9F2Ng5C) and others who have submitted bug reports, suggestions, feedback and provided logs.

## License
```
Boost Software License - Version 1.0 - August 17th, 2003

Copyright (c) 2020 Thomas Smyth

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```
