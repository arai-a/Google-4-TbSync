/*
 * This file is part of Google-4-TbSync.
 * See CONTRIBUTORS.md for details.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

"use strict";

const google = TbSync.providers.google;

var tbSyncEditAccountOverlay = {

    accountNameWidget: null,
    clientIDWidget: null,
    clientSecretWidget: null,
    includeSystemContactGroupsWidget: null,
/*
    checkConnectionWidget: null,
*/

    onload: function(window, accountData) {
        this.accountData = accountData;
        //
        this.accountNameWidget = document.getElementById("tbsync.accountsettings.pref.accountname");
        this.clientIDWidget = document.getElementById("tbsync.accountsettings.pref.clientID");
        this.clientSecretWidget = document.getElementById("tbsync.accountsettings.pref.clientSecret");
        this.includeSystemContactGroupsWidget = document.getElementById('tbsync.accountsettings.pref.includeSystemContactGroups');
        //
        this.accountNameWidget.value = this.accountData.getAccountProperty("accountname");
        this.clientIDWidget.value = this.accountData.getAccountProperty("clientID");
        this.clientSecretWidget.value = this.accountData.getAccountProperty("clientSecret");
        this.includeSystemContactGroupsWidget.checked = ("true" === this.accountData.getAccountProperty("includeSystemContactGroups"));
    },

    updateAccountProperty(accountProperty) {
        switch (accountProperty) {
            case "accountName":
                this.accountData.setAccountProperty("accountname", this.accountNameWidget.value);
                break;
            case "clientID":
                this.accountData.setAccountProperty("clientID", this.clientIDWidget.value);
                break;
            case "clientSecret":
                this.accountData.setAccountProperty("clientSecret", this.clientSecretWidget.value);
                break;
            case "includeSystemContactGroups":
                this.accountData.setAccountProperty("includeSystemContactGroups", this.includeSystemContactGroupsWidget.checked);
                break;
            default:
                break;
        }
    },

    onCheckConnection: function() {
        let accountData = this.accountData;
        //
        let peopleAPI = new PeopleAPI(accountData);
        //
        peopleAPI.checkConnection();
    },

};
