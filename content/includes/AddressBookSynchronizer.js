/*
 * This file is part of Google-4-TbSync.
 * See CONTRIBUTORS.md for details.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

"use strict";

if ("undefined" === typeof IllegalArgumentError) {
    Services.scriptloader.loadSubScript("chrome://google-4-tbsync/content/includes/IllegalArgumentError.js", this, "UTF-8");
}
if ("undefined" === typeof Logger) {
    Services.scriptloader.loadSubScript("chrome://google-4-tbsync/content/includes/Logger.js", this, "UTF-8");
}
if ("undefined" === typeof NetworkError) {
    Services.scriptloader.loadSubScript("chrome://google-4-tbsync/content/includes/NetworkError.js", this, "UTF-8");
}
if ("undefined" === typeof PeopleAPI) {
    Services.scriptloader.loadSubScript("chrome://google-4-tbsync/content/includes/PeopleAPI.js", this, "UTF-8");
}
if ("undefined" === typeof ResponseError) {
    Services.scriptloader.loadSubScript("chrome://google-4-tbsync/content/includes/ResponseError.js", this, "UTF-8");
}

var { XPCOMUtils } = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetters(this, {
    VCardPropertyEntry: "resource:///modules/VCardUtils.jsm",
});

const FAKE_EMAIL_ADDRESS_DOMAIN = "bug1522453.thunderbird.example.com";

class AddressBookSynchronizer {

    /* Main synchronization. */

    static async synchronize(syncData) {
        if (null == syncData) {
            throw new IllegalArgumentError("Invalid 'syncData': null.");
        }
        // Retrieve the target address book.
        let targetAddressBook = syncData.target;
        if (null == targetAddressBook) {
            throw new IllegalArgumentError("Invalid target address book: null.");
        }
        // Create a new PeopleAPI object.
        let peopleAPI = new PeopleAPI(syncData.accountData);
        // Retrieve other account properties.
        let useFakeEmailAddresses = syncData.accountData.getAccountProperty("useFakeEmailAddresses");
        let readOnlyMode = syncData.accountData.getAccountProperty("readOnlyMode");
        let verboseLogging = syncData.accountData.getAccountProperty("verboseLogging");
        // Enable the logger.
        logger = new Logger(verboseLogging);
        // Check for the read-only mode.
        if (readOnlyMode) {
            logger.log0("AddressBookSynchronizer.synchronize(): Read-only mode detected, clearing the change log.");
            // Clear the change log.
            await targetAddressBook.clearChangelog();
        }
        // Prepare the variables for the cycles.
        logger.log0("AddressBookSynchronizer.synchronize(): Retrieving all the local changes since the last synchronization.");
        let addedLocalItemIds = targetAddressBook.getAddedItemsFromChangeLog();
        let modifiedLocalItemIds = targetAddressBook.getModifiedItemsFromChangeLog();
        let deletedLocalItemIds = targetAddressBook.getDeletedItemsFromChangeLog();
        // Attempt the synchronization.
        try {
            // Synchronize contact groups.
            await AddressBookSynchronizer.synchronizeContactGroups(peopleAPI, targetAddressBook, addedLocalItemIds, modifiedLocalItemIds, deletedLocalItemIds, readOnlyMode);
            // Synchronize contacts.
            let contactGroupMemberMap = await AddressBookSynchronizer.synchronizeContacts(peopleAPI, targetAddressBook, addedLocalItemIds, modifiedLocalItemIds, deletedLocalItemIds, useFakeEmailAddresses, readOnlyMode);
            // Synchronize contact group members.
            await AddressBookSynchronizer.synchronizeContactGroupMembers(contactGroupMemberMap, targetAddressBook, readOnlyMode);
            // Fix the change log.
            await AddressBookSynchronizer.fixChangeLog(targetAddressBook);
            //
            logger.log0("AddressBookSynchronizer.synchronize(): Done synchronizing.");
        }
        catch (error) {
            // If a network error was encountered...
            if (error instanceof NetworkError) {
                logger.log0("AddressBookSynchronizer.synchronize(): Network error.");
                // Propagate the error.
                throw error;
            }
            // If the root reason is different...
            else {
                // Propagate the error.
                throw error;
            }
        }
    }

    /* Contact group synchronization. */

    static async synchronizeContactGroups(peopleAPI, targetAddressBook, addedLocalItemIds, modifiedLocalItemIds, deletedLocalItemIds, readOnlyMode) {
        if (null == peopleAPI) {
            throw new IllegalArgumentError("Invalid 'peopleAPI': null.");
        }
        if (null == targetAddressBook) {
            throw new IllegalArgumentError("Invalid 'targetAddressBook': null.");
        }
        if (null == addedLocalItemIds) {
            throw new IllegalArgumentError("Invalid 'addedLocalItemIds': null.");
        }
        if (null == modifiedLocalItemIds) {
            throw new IllegalArgumentError("Invalid 'modifiedLocalItemIds': null.");
        }
        if (null == deletedLocalItemIds) {
            throw new IllegalArgumentError("Invalid 'deletedLocalItemIds': null.");
        }
        if (null == readOnlyMode) {
            throw new IllegalArgumentError("Invalid 'readOnlyMode': null.");
        }
        // Retrieve all server contact groups.
        let serverContactGroups = await peopleAPI.getContactGroups();
        // Cycle on the server contact groups.
        logger.log0("AddressBookSynchronizer.synchronizeContactGroups(): Cycling on the server contact groups.");
        let includeSystemContactGroups = peopleAPI.getIncludeSystemContactGroups();
        logger.log1("PeopleAPI.getContactGroups(): includeSystemContactGroups = " + includeSystemContactGroups);
        for (let serverContactGroup of serverContactGroups) {
            // Get the resource name (in the form 'contactGroups/contactGroupId') and the name.
            let resourceName = serverContactGroup.resourceName;
            let name = serverContactGroup.name;
            logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ")");
            // Determine if the server contact group is a system one and if it should be discarded.
            if (("SYSTEM_CONTACT_GROUP" === serverContactGroup.groupType) && (!includeSystemContactGroups)) {
                logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") is a system contact group and was therefore ignored.");
                continue;
            }
            // Try to match the server contact group locally.
            let localContactGroup = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", resourceName);
            // If such a local contact group is currently unavailable...
            if (null == localContactGroup) {
                // ...and if it was previously deleted locally...
                if (deletedLocalItemIds.includes(resourceName)) {
                    // Check we are not in read-only mode, then...
                    if (!readOnlyMode) {
                        // Delete the server contact group remotely.
                        await peopleAPI.deleteContactGroup(resourceName);
                        logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") was deleted remotely.");
                    }
                    // Remove the resource name from the local change log (deleted items).
                    targetAddressBook.removeItemFromChangeLog(resourceName);
                }
                // ...and if it wasn't previously deleted locally...
                else {
                    // Create a new local contact group.
                    localContactGroup = targetAddressBook.createNewList();
                    // Import the server contact group information into the local contact group.
                    localContactGroup.setProperty("X-GOOGLE-RESOURCENAME", resourceName);
                    localContactGroup.setProperty("X-GOOGLE-ETAG", serverContactGroup.etag);
                    localContactGroup = AddressBookSynchronizer.fillLocalContactGroupWithServerContactGroupInformation(localContactGroup, serverContactGroup);
                    // Add the local contact group locally.
                    await targetAddressBook.addItem(localContactGroup, true);
                    logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") was added locally.");
                    // Remove the resource name from the local change log (added items).
                    // (This should be logically useless, but sometimes the change log is filled with some of the contact groups added above.)
                    targetAddressBook.removeItemFromChangeLog(resourceName);
                }
            }
            // If such a local contact group is currently available...
            else {
                // ...and if the server one is more recent, or if we are in read-only mode...
                if ((localContactGroup.getProperty("X-GOOGLE-ETAG") !== serverContactGroup.etag) || (readOnlyMode)) {
                    // Import the server contact group information into the local contact group.
                    localContactGroup.setProperty("X-GOOGLE-ETAG", serverContactGroup.etag);
                    localContactGroup = AddressBookSynchronizer.fillLocalContactGroupWithServerContactGroupInformation(localContactGroup, serverContactGroup);
                    // Update the local contact group locally.
                    await targetAddressBook.modifyItem(localContactGroup, true);
                    logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") was updated locally.");
                    // Remove the resource name from the local change log (modified items).
                    targetAddressBook.removeItemFromChangeLog(resourceName);
                }
            }
        }
        // Prepare the variables for the cycles.
        let addedLocalItemResourceNames = [];
        // Cycle on the locally added contact groups.
        logger.log0("AddressBookSynchronizer.synchronizeContactGroups(): Cycling on the locally added contact groups.");
        for (let localContactGroupId of addedLocalItemIds) {
            // Retrieve the local contact group, and make sure such an item is actually valid and a real contact group.
            let localContactGroup = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContactGroupId);
            if (null == localContactGroup) {
                continue;
            }
            if (!localContactGroup.isMailList) {
                continue;
            }
            // Check we are not in read-only mode, then...
            if (!readOnlyMode) {
                // Create a new server contact group.
                let serverContactGroup = {};
                // Import the local contact group information into the server contact group.
                serverContactGroup = AddressBookSynchronizer.fillServerContactGroupWithLocalContactGroupInformation(localContactGroup, serverContactGroup);
                // Add the server contact group remotely and get the resource name (in the form 'contactGroups/contactGroupId') and the name.
                serverContactGroup = await peopleAPI.createContactGroup(serverContactGroup);
                let resourceName = serverContactGroup.resourceName;
                let name = serverContactGroup.name;
                logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") was added remotely.");
                // Update the local contact group locally.
                localContactGroup.setProperty("X-GOOGLE-RESOURCENAME", resourceName);
                localContactGroup.setProperty("X-GOOGLE-ETAG", serverContactGroup.etag);
                localContactGroup = AddressBookSynchronizer.fillLocalContactGroupWithServerContactGroupInformation(localContactGroup, serverContactGroup);
                await targetAddressBook.modifyItem(localContactGroup, true);
                // Add the resource name to the proper array.
                addedLocalItemResourceNames.push(resourceName);
            }
            // Remove the local contact group id from the local change log (added items).
            targetAddressBook.removeItemFromChangeLog(localContactGroupId);
        }
        // Cycle on the locally modified contact groups.
        logger.log0("AddressBookSynchronizer.synchronizeContactGroups(): Cycling on the locally modified contact groups.");
        for (let localContactGroupId of modifiedLocalItemIds) {
            // Retrieve the local contact group, and make sure such an item is actually valid and a real contact group.
            let localContactGroup = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContactGroupId);
            if (null == localContactGroup) {
                continue;
            }
            if (!localContactGroup.isMailList) {
                continue;
            }
            // Check we are not in read-only mode, then...
            if (!readOnlyMode) {
                // Make sure the local contact group has a valid X-GOOGLE-ETAG property (if not, it is probably a system contact group, which cannot be updated).
                if (!localContactGroup.getProperty("X-GOOGLE-ETAG")) {
                    logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + localContactGroupId + " has no X-GOOGLE-ETAG property and was therefore ignored.");
                    continue;
                }
                // Create a new server contact group.
                let serverContactGroup = {};
                serverContactGroup.resourceName = localContactGroup.getProperty("X-GOOGLE-RESOURCENAME");
                serverContactGroup.etag = localContactGroup.getProperty("X-GOOGLE-ETAG");
                // Import the local contact group information into the server contact group.
                serverContactGroup = AddressBookSynchronizer.fillServerContactGroupWithLocalContactGroupInformation(localContactGroup, serverContactGroup);
                // Update the server contact group remotely or delete the local contact group locally.
                try {
                    // Update the server contact group remotely and get the resource name (in the form 'contactGroups/contactGroupId') and the name.
                    serverContactGroup = await peopleAPI.updateContactGroup(serverContactGroup);
                    let resourceName = serverContactGroup.resourceName;
                    let name = serverContactGroup.name;
                    logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") was updated remotely.");
                    // Update the local contact group locally.
                    localContactGroup.setProperty("X-GOOGLE-RESOURCENAME", resourceName);
                    localContactGroup.setProperty("X-GOOGLE-ETAG", serverContactGroup.etag);
                    localContactGroup = AddressBookSynchronizer.fillLocalContactGroupWithServerContactGroupInformation(localContactGroup, serverContactGroup);
                    await targetAddressBook.modifyItem(localContactGroup, true);
                }
                catch (error) {
                    // If the server contact group is no longer available (i.e.: it was deleted)...
                    if ((error instanceof ResponseError) && (error.message.includes(": 404:"))) {
                        // Get the resource name (in the form 'contactGroups/contactGroupId').
                        let resourceName = localContactGroup.getProperty("X-GOOGLE-RESOURCENAME");
                        let name = localContactGroup.getProperty("ListName");
                        // Delete the local contact group locally.
/* FIXME: temporary: .deleteItem() does not actually delete a contact group.
                        targetAddressBook.deleteItem(localContactGroup, true);
*/
let abManager = Components.classes["@mozilla.org/abmanager;1"].createInstance(Components.interfaces.nsIAbManager);
abManager.deleteAddressBook(localContactGroup._card.mailListURI);
                        logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + resourceName + " (" + name + ") was deleted locally.");
                    }
                    // If the root reason is different...
                    else {
                        // Propagate the error.
                        throw error;
                    }
                }
            }
            // Remove the local contact group id from the local change log (modified items).
            targetAddressBook.removeItemFromChangeLog(localContactGroupId);
        }
        // Determine all the contact groups which were previously deleted remotely and delete them locally.
        logger.log0("AddressBookSynchronizer.synchronizeContactGroups(): Determining all the remotely deleted contact groups.");
        for (let localContactGroup of targetAddressBook.getAllItems()) {
            // Make sure the item is actually valid and a real contact group.
            if (null == await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContactGroup.getProperty("X-GOOGLE-RESOURCENAME"))) {
                continue;
            }
            if (!localContactGroup.isMailList) {
                continue;
            }
            // Get the local contact group id and the name.
            let localContactGroupId = localContactGroup.getProperty("X-GOOGLE-RESOURCENAME");
            let name = localContactGroup.getProperty("ListName");
            // Check if the local contact group id matches any of the locally added contact groups.
            if (addedLocalItemResourceNames.includes(localContactGroupId)) {
                continue;
            }
            // Check if the local contact group id matches any of the resource names downloaded.
            let localContactGroupFoundAmongServerContactGroups = false;
            for (let serverContactGroup of serverContactGroups) {
                if (localContactGroupId === serverContactGroup.resourceName) {
                    localContactGroupFoundAmongServerContactGroups = true;
                    break;
                }
            }
            if (localContactGroupFoundAmongServerContactGroups) {
                continue;
            }
            // Delete the local contact group locally.
/* FIXME: temporary: .deleteItem() does not actually delete a contact group.
            targetAddressBook.deleteItem(localContactGroup, true);
*/
let abManager = Components.classes["@mozilla.org/abmanager;1"].createInstance(Components.interfaces.nsIAbManager);
abManager.deleteAddressBook(localContactGroup._card.mailListURI);
            logger.log1("AddressBookSynchronizer.synchronizeContactGroups(): " + localContactGroupId + " (" + name + ") was deleted locally.");
        }
    }

    static fillLocalContactGroupWithServerContactGroupInformation(localContactGroup, serverContactGroup) {
        if (null == localContactGroup) {
            throw new IllegalArgumentError("Invalid 'localContactGroup': null.");
        }
        if (null == serverContactGroup) {
            throw new IllegalArgumentError("Invalid 'serverContactGroup': null.");
        }
        // Reset all the properties managed by this method.
        localContactGroup.deleteProperty("ListName");
        // Set the name.
        if (serverContactGroup.name) {
            let finalName = serverContactGroup.name.replace(/[<>;,"]/g, '_');
            localContactGroup.setProperty("ListName", finalName);
        }
        //
        return localContactGroup;
    }

    static fillServerContactGroupWithLocalContactGroupInformation(localContactGroup, serverContactGroup) {
        if (null == localContactGroup) {
            throw new IllegalArgumentError("Invalid 'localContactGroup': null.");
        }
        if (null == serverContactGroup) {
            throw new IllegalArgumentError("Invalid 'serverContactGroup': null.");
        }
        // Reset all the properties managed by this method.
        delete serverContactGroup.name;
        // Set the name.
        if (localContactGroup.getProperty("ListName")) {
            serverContactGroup.name = localContactGroup.getProperty("ListName");
        }
        //
        return serverContactGroup;
    }

    /* Contact synchronization. */

    static async synchronizeContacts(peopleAPI, targetAddressBook, addedLocalItemIds, modifiedLocalItemIds, deletedLocalItemIds, useFakeEmailAddresses, readOnlyMode) {
        if (null == peopleAPI) {
            throw new IllegalArgumentError("Invalid 'peopleAPI': null.");
        }
        if (null == targetAddressBook) {
            throw new IllegalArgumentError("Invalid 'targetAddressBook': null.");
        }
        if (null == addedLocalItemIds) {
            throw new IllegalArgumentError("Invalid 'addedLocalItemIds': null.");
        }
        if (null == modifiedLocalItemIds) {
            throw new IllegalArgumentError("Invalid 'modifiedLocalItemIds': null.");
        }
        if (null == deletedLocalItemIds) {
            throw new IllegalArgumentError("Invalid 'deletedLocalItemIds': null.");
        }
        if (null == useFakeEmailAddresses) {
            throw new IllegalArgumentError("Invalid 'useFakeEmailAddresses': null.");
        }
        if (null == readOnlyMode) {
            throw new IllegalArgumentError("Invalid 'readOnlyMode': null.");
        }
// FIXME: temporary.
        // Prepare the variables for the cycles.
        let contactGroupMemberMap = new Map();
        // Retrieve all server contacts.
        let serverContacts = await peopleAPI.getContacts();
        // Cycle on the server contacts.
        logger.log0("AddressBookSynchronizer.synchronizeContacts(): Cycling on the server contacts.");
        for (let serverContact of serverContacts) {
            // Get the resource name (in the form 'people/personId') and the display name.
            let resourceName = serverContact.resourceName;
            let displayName = (serverContact.names ? serverContact.names[0].displayName : "-");
            logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ")");
            // Try to match the server contact locally.
            let localContact = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", resourceName);
            // If such a local contact is currently unavailable...
            if (null == localContact) {
                // ...and if it was previously deleted locally...
                if (deletedLocalItemIds.includes(resourceName)) {
                    // Check we are not in read-only mode, then...
                    if (!readOnlyMode) {
                        // Delete the server contact remotely.
                        await peopleAPI.deleteContact(resourceName);
                        logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ") was deleted remotely.");
                    }
                    // Remove the resource name from the local change log (deleted items).
                    targetAddressBook.removeItemFromChangeLog(resourceName);
                }
                // ...and if it wasn't previously deleted locally...
                else {
                    // Create a new local contact.
                    localContact = targetAddressBook.createNewCard();
                    // Import the server contact information into the local contact.
                    localContact.setProperty("X-GOOGLE-RESOURCENAME", resourceName);
                    localContact.setProperty("X-GOOGLE-ETAG", serverContact.etag);
                    localContact = AddressBookSynchronizer.fillLocalContactWithServerContactInformation(localContact, serverContact, useFakeEmailAddresses);
                    // Add the local contact locally.
                    await targetAddressBook.addItem(localContact, true);
                    logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ") was added locally.");
                    // Remove the resource name from the local change log (added items).
                    // (This should be logically useless, but sometimes the change log is filled with some of the contacts added above.)
                    targetAddressBook.removeItemFromChangeLog(resourceName);
// FIXME: temporary,
                    // Update the contact group member map.
                    contactGroupMemberMap = AddressBookSynchronizer.updateContactGroupMemberMap(contactGroupMemberMap, resourceName, serverContact.memberships);
                }
            }
            // If such a local contact is currently available...
            else {
                // ...and if the server one is more recent, or if we are in read-only mode...
                if ((localContact.getProperty("X-GOOGLE-ETAG") !== serverContact.etag) || (readOnlyMode)) {
                    // Import the server contact information into the local contact.
                    localContact.setProperty("X-GOOGLE-ETAG", serverContact.etag);
                    localContact = AddressBookSynchronizer.fillLocalContactWithServerContactInformation(localContact, serverContact, useFakeEmailAddresses);
                    // Update the local contact locally.
                    await targetAddressBook.modifyItem(localContact, true);
                    logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ") was updated locally.");
                    // Remove the resource name from the local change log (modified items).
                    targetAddressBook.removeItemFromChangeLog(resourceName);
                }
// FIXME: temporary.
                // Update the contact group member map.
                contactGroupMemberMap = AddressBookSynchronizer.updateContactGroupMemberMap(contactGroupMemberMap, resourceName, serverContact.memberships);
            }
        }
        // Prepare the variables for the cycles.
        let addedLocalItemResourceNames = [];
        // Cycle on the locally added contacts.
        logger.log0("AddressBookSynchronizer.synchronizeContacts(): Cycling on the locally added contacts.");
        for (let localContactId of addedLocalItemIds) {
            // Retrieve the local contact, and make sure such an item is actually valid and not a contact group.
            let localContact = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContactId);
            if (null == localContact) {
                continue;
            }
            if (localContact.isMailList) {
                continue;
            }
            // Check we are not in read-only mode, then...
            if (!readOnlyMode) {
                // Create a new server contact.
                let serverContact = {};
                // Import the local contact information into the server contact.
                serverContact = AddressBookSynchronizer.fillServerContactWithLocalContactInformation(localContact, serverContact, useFakeEmailAddresses);
                // Add the server contact remotely and get the resource name (in the form 'people/personId') and the display name.
                serverContact = await peopleAPI.createContact(serverContact);
                let resourceName = serverContact.resourceName;
                let displayName = (serverContact.names ? serverContact.names[0].displayName : "-");
                logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ") was added remotely.");
                // Update the local contact locally.
                localContact.setProperty("X-GOOGLE-RESOURCENAME", resourceName);
                localContact.setProperty("X-GOOGLE-ETAG", serverContact.etag);
                localContact = AddressBookSynchronizer.fillLocalContactWithServerContactInformation(localContact, serverContact, useFakeEmailAddresses);
                await targetAddressBook.modifyItem(localContact, true);
                // Add the resource name to the proper array.
                addedLocalItemResourceNames.push(resourceName);
            }
            // Remove the local contact id from the local change log (added items).
            targetAddressBook.removeItemFromChangeLog(localContactId);
        }
        // Cycle on the locally modified contacts.
        logger.log0("AddressBookSynchronizer.synchronizeContacts(): Cycling on the locally modified contacts.");
        for (let localContactId of modifiedLocalItemIds) {
            // Retrieve the local contact, and make sure such an item is actually valid and not a contact group.
            let localContact = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContactId);
            if (null == localContact) {
                continue;
            }
            if (localContact.isMailList) {
                continue;
            }
            // Check we are not in read-only mode, then...
            if (!readOnlyMode) {
                // Create a new server contact.
                let serverContact = {};
                serverContact.resourceName = localContact.getProperty("X-GOOGLE-RESOURCENAME");
                serverContact.etag = localContact.getProperty("X-GOOGLE-ETAG");
                // Import the local contact information into the server contact.
                serverContact = AddressBookSynchronizer.fillServerContactWithLocalContactInformation(localContact, serverContact, useFakeEmailAddresses);
                // Update the server contact remotely or delete the local contact locally.
                try {
                    // Update the server contact remotely and get the resource name (in the form 'people/personId') and the display name.
                    serverContact = await peopleAPI.updateContact(serverContact);
                    let resourceName = serverContact.resourceName;
                    let displayName = (serverContact.names ? serverContact.names[0].displayName : "-");
                    logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ") was updated remotely.");
                    // Update the local contact locally.
                    localContact.setProperty("X-GOOGLE-RESOURCENAME", resourceName);
                    localContact.setProperty("X-GOOGLE-ETAG", serverContact.etag);
                    localContact = AddressBookSynchronizer.fillLocalContactWithServerContactInformation(localContact, serverContact, useFakeEmailAddresses);
                    await targetAddressBook.modifyItem(localContact, true);
                }
                catch (error) {
                    // If the server contact is no longer available (i.e.: it was deleted)...
                    if ((error instanceof ResponseError) && (error.message.includes("404"))) {
                        // Get the resource name (in the form 'people/personId').
                        let resourceName = localContact.getProperty("X-GOOGLE-RESOURCENAME");
                        let displayName = (localContact.getProperty("DisplayName") ? localContact.getProperty("DisplayName") : "-");
                        // Delete the local contact locally.
                        targetAddressBook.deleteItem(localContact, true);
                        logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + resourceName + " (" + displayName + ") was deleted locally.");
                    }
                    // If the root reason is different...
                    else {
                        // Propagate the error.
                        throw error;
                    }
                }
            }
            // Remove the local contact id from the local change log (modified items).
            targetAddressBook.removeItemFromChangeLog(localContactId);
        }
        // Determine all the contacts which were previously deleted remotely and delete them locally.
        logger.log0("AddressBookSynchronizer.synchronizeContacts(): Determining all the remotely deleted contacts.");
        for (let localContact of targetAddressBook.getAllItems()) {
            // Make sure the item is actually valid and not a contact group.
            if (null == await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContact.getProperty("X-GOOGLE-RESOURCENAME"))) {
                continue;
            }
            if (localContact.isMailList) {
                continue;
            }
            // Get the local contact id and the display name.
            let localContactId = localContact.getProperty("X-GOOGLE-RESOURCENAME");
            let displayName = localContact.getProperty("DisplayName");
            // Check if the local contact id matches any of the locally added contacts.
            if (addedLocalItemResourceNames.includes(localContactId)) {
                continue;
            }
            // Check if the local contact id matches any of the resource names downloaded.
            let localContactFoundAmongServerContacts = false;
            for (let serverContact of serverContacts) {
                if (localContactId === serverContact.resourceName) {
                    localContactFoundAmongServerContacts = true;
                    break;
                }
            }
            if (localContactFoundAmongServerContacts) {
                continue;
            }
            // Delete the local contact locally.
            targetAddressBook.deleteItem(localContact, true);
            logger.log1("AddressBookSynchronizer.synchronizeContacts(): " + localContactId + " (" + displayName + ") was deleted locally.");
        }
// FIXME: temporary.
        //
        return contactGroupMemberMap;
    }

    static fillLocalContactWithServerContactInformation(localContact, serverContact, useFakeEmailAddresses) {
        if (null == localContact) {
            throw new IllegalArgumentError("Invalid 'localContact': null.");
        }
        if (null == serverContact) {
            throw new IllegalArgumentError("Invalid 'serverContact': null.");
        }
        if (null == useFakeEmailAddresses) {
            throw new IllegalArgumentError("Invalid 'useFakeEmailAddresses': null.");
        }
        // Reset all the properties managed by this method.
        localContact._card.vCardProperties.clearValues("n");
        localContact._card.vCardProperties.clearValues("fn");
        localContact._card.vCardProperties.clearValues("nickname");
        localContact._card.vCardProperties.clearValues("email");
        localContact._card.vCardProperties.clearValues("url");
        localContact._card.vCardProperties.clearValues("adr");
        localContact._card.vCardProperties.clearValues("tel");
        localContact._card.vCardProperties.clearValues("impp");
        localContact._card.vCardProperties.clearValues("bday");
        localContact._card.vCardProperties.clearValues("anniversary");
        localContact._card.vCardProperties.clearValues("note");
        localContact._card.vCardProperties.clearValues("title");
        localContact._card.vCardProperties.clearValues("org");
        localContact._card.vCardProperties.clearValues("x-custom1");
        localContact._card.vCardProperties.clearValues("x-custom2");
        localContact._card.vCardProperties.clearValues("x-custom3");
        localContact._card.vCardProperties.clearValues("x-custom4");
        // Set the name and the display name.
        if (serverContact.names) {
            let n_values = [ "", "", "", "", "" ];
            let fn_values = [ "" ];
            //
            if (serverContact.names[0] && serverContact.names[0].honorificPrefix) {
                n_values[3] = serverContact.names[0].honorificPrefix;
            }
            if (serverContact.names[0] && serverContact.names[0].givenName) {
                n_values[1] = serverContact.names[0].givenName;
            }
            if (serverContact.names[0] && serverContact.names[0].middleName) {
                n_values[2] = serverContact.names[0].middleName;
            }
            if (serverContact.names[0] && serverContact.names[0].familyName) {
                n_values[0] = serverContact.names[0].familyName;
            }
            if (serverContact.names[0] && serverContact.names[0].honorificSuffix) {
                n_values[4] = serverContact.names[0].honorificSuffix;
            }
            if (serverContact.names[0] && serverContact.names[0].displayName) {
                fn_values[0] = serverContact.names[0].displayName;
            }
            //
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("n", {}, "array", n_values));
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("fn", {}, "text", fn_values[0]));
        }
        // Set the nickname.
        if (serverContact.nicknames) {
            let nickname_values = [ "" ];
            //
            if (serverContact.nicknames[0] && serverContact.nicknames[0].value) {
                nickname_values[0] = serverContact.nicknames[0].value;
            }
            //
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("nickname", {}, "array", nickname_values));
        }
        // Set the email addresses.
        if (serverContact.emailAddresses) {
            let pref_param = "1";
            //
            for (let emailAddress of serverContact.emailAddresses) {
                let email_values = [ "" ];
                let email_type_param = "";
                //
                if (emailAddress.value) {
                    email_values[0] = emailAddress.value;
                }
                switch (emailAddress.type) {
                    case "home":
                        email_type_param = "home";
                        //
                        break;
                    case "work":
                        email_type_param = "work";
                        //
                        break;
                    default:
                        email_type_param = "";
                        //
                        break;
                }
                //
                localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("email", { type: email_type_param, pref: pref_param }, "text", email_values[0]));
                //
                pref_param = "";
            }
        }
        else if (useFakeEmailAddresses) {
            let email_values = [ "" ];
            let email_type_param = "";
            //
            email_values[0] = Date.now() + "." + Math.random() + "@" + FAKE_EMAIL_ADDRESS_DOMAIN;
            //
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("email", { type: email_type_param }, "text", email_values[0]));
        }
        // Set the websites.
        if (serverContact.urls) {
            for (let url of serverContact.urls) {
                let url_values = [ "" ];
                let url_type_param = "";
                //
                if (url.value) {
                    url_values[0] = url.value;
                }
                switch (url.type) {
                    case "work":
                        url_type_param = "work";
                        //
                        break;
                    default:
                        url_type_param = "";
                        //
                        break;
                }
                //
                localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("url", { type: url_type_param }, "array", url_values));
            }
        }
        // Set the addresses.
        if (serverContact.addresses) {
            for (let address of serverContact.addresses) {
                let adr_values = [ "", "", "", "", "", "", "" ];
                let adr_type_param = "";
                //
                if (address.streetAddress || address.extendedAddress) {
                    adr_values[2] = [];
                }
                if (address.streetAddress) {
                    adr_values[2][0] = address.streetAddress.replaceAll(", ", " ").replaceAll(",", " ");
                }
                if (address.extendedAddress) {
                    if (!address.streetAddress) {
                        adr_values[2][0] = "-";
                    }
                    adr_values[2][1] = address.extendedAddress.replaceAll(", ", " ").replaceAll(",", " ");
                }
                if (address.city) {
                    adr_values[3] = address.city;
                }
                if (address.region) {
                    adr_values[4] = address.region;
                }
                if (address.postalCode) {
                    adr_values[5] = address.postalCode;
                }
                if (address.country) {
                    adr_values[6] = address.country;
                }
                switch (address.type) {
                    case "home":
                        adr_type_param = "home";
                        //
                        break;
                    case "work":
                        adr_type_param = "work";
                        //
                        break;
                    default:
                        adr_type_param = "";
                        //
                        break;
                }
                //
                localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("adr", { type: adr_type_param }, "array", adr_values));
            }
        }
        // Set the phone numbers.
        if (serverContact.phoneNumbers) {
            for (let phoneNumber of serverContact.phoneNumbers) {
                let tel_values = [ "" ];
                let tel_type_param = "";
                //
                if (phoneNumber.value) {
                    tel_values[0] = phoneNumber.value;
                }
                switch (phoneNumber.type) {
                    case "home":
                        tel_type_param = "home";
                        //
                        break;
                    case "work":
                        tel_type_param = "work";
                        //
                        break;
                    case "mobile":
                        tel_type_param = "cell";
                        //
                        break;
                    case "Home Fax":
                    case "Work Fax":
                        tel_type_param = "fax";
                        //
                        break;
                    case "pager":
                        tel_type_param = "pager";
                        //
                        break;
                    default:
                        tel_type_param = "";
                        //
                        break;
                }
                //
                localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("tel", { type: tel_type_param }, "array", tel_values));
            }
        }
        // Set the chat accounts.
        if (serverContact.imClients) {
            for (let imClient of serverContact.imClients) {
                let impp_values = [ "" ];
                //
                if (imClient.protocol && imClient.username) {
                    impp_values[0] = imClient.protocol + ":" + imClient.username;
                }
                //
                localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("impp", {}, "array", impp_values));
            }
        }
        // Set the special dates.
        if (serverContact.birthdays) {
            let bday_values = [ "" ];
            //
            if (serverContact.birthdays[0] && serverContact.birthdays[0].date) {
                let year = (serverContact.birthdays[0].date.year ? String(serverContact.birthdays[0].date.year).padStart(4, "0") : "-");
                let month = (serverContact.birthdays[0].date.month ? String(serverContact.birthdays[0].date.month).padStart(2, "0") : "-");
                let day = (serverContact.birthdays[0].date.day ? String(serverContact.birthdays[0].date.day).padStart(2, "0") : "-");
                //
                bday_values[0] = year + "-" + month + "-" + day;
            }
            //
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("bday", {}, "date-and-or-time", bday_values[0]));
        }
        if (serverContact.events) {
            for (let event of serverContact.events) {
                let anniversary_values = [ "" ];
                //
                if (event && event.date) {
                    let year = (event.date.year ? String(event.date.year).padStart(4, "0") : "-");
                    let month = (event.date.month ? String(event.date.month).padStart(2, "0") : "-");
                    let day = (event.date.day ? String(event.date.day).padStart(2, "0") : "-");
                    //
                    anniversary_values[0] = year + "-" + month + "-" + day;
                }
                //
                localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("anniversary", {}, "date-and-or-time", anniversary_values[0]));
            }
        }
        // Set the notes.
        if (serverContact.biographies) {
            let note_values = [ "" ];
            //
            if (serverContact.biographies[0] && serverContact.biographies[0].value) {
                note_values[0] = serverContact.biographies[0].value;
            }
            //
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("note", {}, "array", note_values));
        }
        // Set the organizational properties.
        if (serverContact.organizations) {
            let title_values = [ "" ];
            let org_values = [ "" ];
            //
            if (serverContact.organizations[0] && serverContact.organizations[0].title) {
                title_values[0] = serverContact.organizations[0].title;
            }
            if (serverContact.organizations[0] && serverContact.organizations[0].name) {
                org_values[0] = serverContact.organizations[0].name;
            }
            if (serverContact.organizations[0] && serverContact.organizations[0].department) {
// FIXME: temporary.
                if (!serverContact.organizations[0].name) {
                    org_values[0] = "-"; // necessary because TB considers the first item to be the name
                }
                org_values[1] = serverContact.organizations[0].department;
            }
            //
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("title", {}, "array", title_values));
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("org", {}, "array", org_values));
        }
        // Set the custom properties.
        if (serverContact.userDefined) {
            let x_custom1_values = [ "" ];
            let x_custom2_values = [ "" ];
            let x_custom3_values = [ "" ];
            let x_custom4_values = [ "" ];
            //
            if (serverContact.userDefined[0] && serverContact.userDefined[0].value) {
                x_custom1_values[0] = serverContact.userDefined[0].value;
            }
            if (serverContact.userDefined[1] && serverContact.userDefined[1].value) {
                x_custom2_values[0] = serverContact.userDefined[1].value;
            }
            if (serverContact.userDefined[2] && serverContact.userDefined[2].value) {
                x_custom3_values[0] = serverContact.userDefined[2].value;
            }
            if (serverContact.userDefined[3] && serverContact.userDefined[3].value) {
                x_custom4_values[0] = serverContact.userDefined[3].value;
            }
            //
/* FIXME: temporary workaround for a TB bug.
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom1", {}, "array", x_custom1_values));
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom2", {}, "array", x_custom2_values));
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom3", {}, "array", x_custom3_values));
            localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom4", {}, "array", x_custom4_values));
*/
localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom1", {}, "array", x_custom1_values[0]));
localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom2", {}, "array", x_custom2_values[0]));
localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom3", {}, "array", x_custom3_values[0]));
localContact._card.vCardProperties.addEntry(new VCardPropertyEntry("x-custom4", {}, "array", x_custom4_values[0]));
        }
        //
        return localContact;
    }

    static fillServerContactWithLocalContactInformation(localContact, serverContact, useFakeEmailAddresses) {
        if (null == localContact) {
            throw new IllegalArgumentError("Invalid 'localContact': null.");
        }
        if (null == serverContact) {
            throw new IllegalArgumentError("Invalid 'serverContact': null.");
        }
        if (null == useFakeEmailAddresses) {
            throw new IllegalArgumentError("Invalid 'useFakeEmailAddresses': null.");
        }
        // Reset all the properties managed by this method.
        delete serverContact.names;
        delete serverContact.nicknames;
        delete serverContact.emailAddresses;
        delete serverContact.urls;
        delete serverContact.addresses;
        delete serverContact.phoneNumbers;
        delete serverContact.imClients;
        delete serverContact.birthdays;
        delete serverContact.events;
        delete serverContact.biographies;
        delete serverContact.organizations;
        delete serverContact.userDefined;
        // Set the name and the display name.
        let n_entry = localContact._card.vCardProperties.getFirstEntry("n");
        let fn_entry = localContact._card.vCardProperties.getFirstEntry("fn");
        if (n_entry || fn_entry) {
            serverContact.names = [];
            //
            serverContact.names[0] = {};
            //
            if (n_entry) {
                let n_values = n_entry.value; // n_entry.value: array
                //
                if (n_values[3]) {
                    serverContact.names[0].honorificPrefix = n_values[3];
                }
                if (n_values[1]) {
                    serverContact.names[0].givenName = n_values[1];
                }
                if (n_values[2]) {
                    serverContact.names[0].middleName = n_values[2];
                }
                if (n_values[0]) {
                    serverContact.names[0].familyName = n_values[0];
                }
                if (n_values[4]) {
                    serverContact.names[0].honorificSuffix = n_values[4];
                }
            }
/* Disabled, as names[0].displayName is an output-only field for Google.
            if (fn_entry) {
                let fn_values = [ fn_entry.value ]; // fn_entry.value: string
                //
                if (fn_values[0]) {
                    serverContact.names[0].displayName = fn_values[0];
                }
            }
*/
        }
        // Set the nickname.
        let nickname_entry = localContact._card.vCardProperties.getFirstEntry("nickname");
        if (nickname_entry) {
            serverContact.nicknames = [];
            //
            serverContact.nicknames[0] = {};
            //
            let nickname_values = [ nickname_entry.value ]; // nickname_entry.value: string
            //
            if (nickname_values[0]) {
                serverContact.nicknames[0].value = nickname_values[0];
            }
        }
        // Set the email addresses.
        let email_entries = localContact._card.vCardProperties.getAllEntries("email");
        if (email_entries) {
            serverContact.emailAddresses = [];
            let i = 0;
            //
            for (let email_entry of email_entries) {
                if ((email_entry.value.endsWith("@" + FAKE_EMAIL_ADDRESS_DOMAIN)) && (useFakeEmailAddresses)) {
                    continue;
                }
                //
                serverContact.emailAddresses[i] = {};
                //
                let email_values = [ email_entry.value ]; // email_entry.value: string
                let email_type_param = email_entry.params.type;
                //
                if (email_values[0]) {
                    serverContact.emailAddresses[i].value = email_values[0];
                }
                switch (email_type_param) {
                    case "work":
                        serverContact.emailAddresses[i].type = "work";
                        //
                        break;
                    case "home":
                        serverContact.emailAddresses[i].type = "home";
                        //
                        break;
                    default:
                        serverContact.emailAddresses[i].type = "other";
                        //
                        break;
                }
                //
                i++;
            }
            //
            if (0 == serverContact.emailAddresses.length) {
                delete serverContact.emailAddresses;
            }
        }
        // Set the websites.
        let url_entries = localContact._card.vCardProperties.getAllEntries("url");
        if (url_entries) {
            serverContact.urls = [];
            let i = 0;
            //
            for (let url_entry of url_entries) {
                serverContact.urls[i] = {};
                //
                let url_values = [ url_entry.value ]; // url_entry.value: string
                let url_type_param = url_entry.params.type;
                //
                if (url_values[0]) {
                    serverContact.urls[i].value = url_values[0];
                }
                switch (url_type_param) {
                    case "work":
                        serverContact.urls[i].type = "work";
                        //
                        break;
                    default:
                        serverContact.urls[i].type = "";
                        //
                        break;
                }
                //
                i++;
            }
        }
        // Set the addresses.
        let adr_entries = localContact._card.vCardProperties.getAllEntries("adr");
        if (adr_entries) {
            serverContact.addresses = [];
            let i = 0;
            //
            for (let adr_entry of adr_entries) {
                serverContact.addresses[i] = {};
                //
                let adr_values = adr_entry.value; // adr_entry.value: array
                let adr_type_param = adr_entry.params.type;
                //
                if (adr_values[2]) {
                    let adr_values_2_values = (Array.isArray(adr_values[2]) ? adr_values[2] : [ adr_values[2] ]); // adr_values[2]: string or array
                    //
                    if (adr_values_2_values[0]) {
                        serverContact.addresses[i].streetAddress = adr_values_2_values[0].replaceAll(", ", " ").replaceAll(",", " ");
                    }
                    if (adr_values_2_values[1]) {
                        serverContact.addresses[i].extendedAddress = adr_values_2_values[1].replaceAll(", ", " ").replaceAll(",", " ");
                    }
                }
                if (adr_values[3]) {
                    serverContact.addresses[i].city = adr_values[3];
                }
                if (adr_values[4]) {
                    serverContact.addresses[i].region = adr_values[4];
                }
                if (adr_values[5]) {
                    serverContact.addresses[i].postalCode = adr_values[5];
                }
                if (adr_values[6]) {
                    serverContact.addresses[i].country = adr_values[6];
                }
                switch (adr_type_param) {
                    case "work":
                        serverContact.addresses[i].type = "work";
                        //
                        break;
                    case "home":
                        serverContact.addresses[i].type = "home";
                        //
                        break;
                    default:
                        serverContact.addresses[i].type = "";
                        //
                        break;
                }
                //
                i++;
            }
        }
        // Set the phone numbers.
        let tel_entries = localContact._card.vCardProperties.getAllEntries("tel");
        if (tel_entries) {
            serverContact.phoneNumbers = [];
            let i = 0;
            //
            for (let tel_entry of tel_entries) {
                serverContact.phoneNumbers[i] = {};
                //
                let tel_values = [ tel_entry.value ]; // tel_entry.value: string
                let tel_type_param = tel_entry.params.type;
                //
                if (tel_values[0]) {
                    serverContact.phoneNumbers[i].value = tel_values[0];
                }
                switch (tel_type_param) {
                    case "work":
                        serverContact.phoneNumbers[i].type = "work";
                        //
                        break;
                    case "home":
                        serverContact.phoneNumbers[i].type = "home";
                        //
                        break;
                    case "cell":
                        serverContact.phoneNumbers[i].type = "mobile";
                        //
                        break;
                    case "fax":
                        serverContact.phoneNumbers[i].type = "Work Fax";
                        //
                        break;
                    case "pager":
                        serverContact.phoneNumbers[i].type = "pager";
                        //
                        break;
                    default:
                        serverContact.phoneNumbers[i].type = "";
                        //
                        break;
                }
                //
                i++;
            }
        }
        // Set the chat accounts.
        let impp_entries = localContact._card.vCardProperties.getAllEntries("impp");
        if (impp_entries) {
            serverContact.imClients = [];
            let i = 0;
            //
            for (let impp_entry of impp_entries) {
                serverContact.imClients[i] = {};
                //
                let impp_values = [ impp_entry.value ]; // impp_entry.value: string
                //
                if (impp_values[0] && impp_values[0].includes(":")) {
                    let impp_values_pu = impp_values[0].split(":");
                    //
                    serverContact.imClients[i].username = impp_values_pu[1];
                    serverContact.imClients[i].protocol = impp_values_pu[0];
                }
                //
                i++;
            }
        }
        // Set the special dates.
        let bday_entry = localContact._card.vCardProperties.getFirstEntry("bday");
        let anniversary_entries = localContact._card.vCardProperties.getAllEntries("anniversary");
        if (bday_entry) {
            serverContact.birthdays = [];
            //
            serverContact.birthdays[0] = {};
            serverContact.birthdays[0].date = {};
            //
            let bday_values = [ bday_entry.value ]; // bday_entry.value: string
            //
            let year = "";
            let month = "";
            let day = "";
            let c = 0;
            if ("-" == bday_values[0].substring(c, c + 1)) {
                c += 2;
            }
            else {
                year = bday_values[0].substring(c, c + 4);
                c += 5;
            }
            if ("-" == bday_values[0].substring(c, c + 1)) {
                c += 2;
            }
            else {
                month = bday_values[0].substring(c, c + 2);
                c += 3;
            }
            if ("-" == bday_values[0].substring(c, c + 1)) {
                c += 2;
            }
            else {
                day = bday_values[0].substring(c, c + 2);
                c += 3;
            }
            //
            if (month) {
                serverContact.birthdays[0].date.month = month;
            }
            if (day) {
                serverContact.birthdays[0].date.day = day;
            }
            if (year) {
                serverContact.birthdays[0].date.year = year;
            }
        }
        if (anniversary_entries) {
            serverContact.events = [];
            let i = 0;
            //
            for (let anniversary_entry of anniversary_entries) {
                serverContact.events[i] = {};
                serverContact.events[i].date = {};
                //
                let anniversary_values = [ anniversary_entry.value ]; // anniversary_entry.value: string
                //
                let year = "";
                let month = "";
                let day = "";
                let c = 0;
                if ("-" == anniversary_values[0].substring(c, c + 1)) {
                    c += 2;
                }
                else {
                    year = anniversary_values[0].substring(c, c + 4);
                    c += 5;
                }
                if ("-" == anniversary_values[0].substring(c, c + 1)) {
                    c += 2;
                }
                else {
                    month = anniversary_values[0].substring(c, c + 2);
                    c += 3;
                }
                if ("-" == anniversary_values[0].substring(c, c + 1)) {
                    c += 2;
                }
                else {
                    day = anniversary_values[0].substring(c, c + 2);
                    c += 3;
                }
                //
                if (month && day) {
                    if (month) {
                        serverContact.events[i].date.month = month;
                    }
                    if (day) {
                        serverContact.events[i].date.day = day;
                    }
                    if (year) {
                        serverContact.events[i].date.year = year;
                    }
                }
                //
                i++;
            }
        }
        // Set the notes.
        let note_entry = localContact._card.vCardProperties.getFirstEntry("note");
        if (note_entry) {
            serverContact.biographies = [];
            //
            serverContact.biographies[0] = {};
            //
            let note_values = [ note_entry.value ]; // note_entry.value: string
            //
            if (note_values[0]) {
                serverContact.biographies[0].value = note_values[0];
            }
        }
        // Set the organizational properties.
        let title_entry = localContact._card.vCardProperties.getFirstEntry("title");
        let org_entry = localContact._card.vCardProperties.getFirstEntry("org");
        if (title_entry || org_entry) {
            serverContact.organizations = [];
            //
            serverContact.organizations[0] = {};
            //
            if (title_entry) {
                let title_values = [ title_entry.value ]; // title_entry.value: string
                //
                if (title_values[0]) {
                    serverContact.organizations[0].title = title_values[0];
                }
            }
            if (org_entry) {
                let org_values = (Array.isArray(org_entry.value) ? org_entry.value : [ org_entry.value ]); // org_entry.value: string or array
                //
                if (org_values[0]) {
                    serverContact.organizations[0].name = org_values[0];
                }
                if (org_values[1]) {
                    serverContact.organizations[0].department = org_values[1];
                }
            }
        }
        // Set the custom properties.
        let x_custom1_entry = localContact._card.vCardProperties.getFirstEntry("x-custom1");
        let x_custom2_entry = localContact._card.vCardProperties.getFirstEntry("x-custom2");
        let x_custom3_entry = localContact._card.vCardProperties.getFirstEntry("x-custom3");
        let x_custom4_entry = localContact._card.vCardProperties.getFirstEntry("x-custom4");
        if (x_custom1_entry || x_custom2_entry || x_custom3_entry || x_custom4_entry) {
            serverContact.userDefined = [];
            let i = 0;
            //
            if (x_custom1_entry) {
                serverContact.userDefined[i] = {};
                //
                let x_custom1_values = [ x_custom1_entry.value ]; // x_custom1_entry.value: string
                //
                if (x_custom1_values[0]) {
                    serverContact.userDefined[i].key = "-";
                    serverContact.userDefined[i].value = x_custom1_values[0];
                    //
                    i++;
                }
            }
            if (x_custom2_entry) {
                serverContact.userDefined[i] = {};
                //
                let x_custom2_values = [ x_custom2_entry.value ]; // x_custom2_entry.value: string
                //
                if (x_custom2_values[0]) {
                    serverContact.userDefined[i].key = "-";
                    serverContact.userDefined[i].value = x_custom2_values[0];
                    //
                    i++;
                }
            }
            if (x_custom3_entry) {
                serverContact.userDefined[i] = {};
                //
                let x_custom3_values = [ x_custom3_entry.value ]; // x_custom3_entry.value: string
                //
                if (x_custom3_values[0]) {
                    serverContact.userDefined[i].key = "-";
                    serverContact.userDefined[i].value = x_custom3_values[0];
                    //
                    i++;
                }
            }
            if (x_custom4_entry) {
                serverContact.userDefined[i] = {};
                //
                let x_custom4_values = [ x_custom4_entry.value ]; // x_custom4_entry.value: string
                //
                if (x_custom4_values[0]) {
                    serverContact.userDefined[i].key = "-";
                    serverContact.userDefined[i].value = x_custom4_values[0];
                    //
                    i++;
                }
            }
        }
        //
        return serverContact;
    }

    /* Contact group member synchronization. */

    static async synchronizeContactGroupMembers(contactGroupMemberMap, targetAddressBook, readOnlyMode) { // https://developer.mozilla.org/en-US/docs/Mozilla/Thunderbird/Address_Book_Examples
        if (null == contactGroupMemberMap) {
            throw new IllegalArgumentError("Invalid 'contactGroupMemberMap': null.");
        }
        if (null == targetAddressBook) {
            throw new IllegalArgumentError("Invalid 'targetAddressBook': null.");
        }
        if (null == readOnlyMode) {
            throw new IllegalArgumentError("Invalid 'readOnlyMode': null.");
        }
// FIXME: temporary (Google-to-Thunderbird only synchronization).
        // Cycle on the local contact groups.
        logger.log0("AddressBookSynchronizer.synchronizeContactGroupMembers(): Determining all the members for each contact group.");
        for (let localContactGroup of targetAddressBook.getAllItems()) {
            // Make sure the item is actually valid and a real contact group.
            if (null == await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", localContactGroup.getProperty("X-GOOGLE-RESOURCENAME"))) {
                continue;
            }
            if (!localContactGroup.isMailList) {
                continue;
            }
            // Retrieve the local contact group directory.
            let abManager = Components.classes["@mozilla.org/abmanager;1"].getService(Components.interfaces.nsIAbManager);
            let localContactGroupDirectory = abManager.getDirectory(localContactGroup._card.mailListURI);
            // Clear the local contact group.
// FIXME: temporary.
/* FIXME: childCards.pop() seems to not always pop actually, resulting in an infinite loop...
            if (undefined !== localContactGroupDirectory.childCards) {
                while (0 < localContactGroupDirectory.childCards.length) {
                    localContactGroupDirectory.childCards.pop();
                }
            }
*/
localContactGroupDirectory.deleteCards(localContactGroupDirectory.childCards);
            // Fill the local contact group with the server contact group members.
// FIXME: temporary.
            let contactResourceNames = contactGroupMemberMap.get(localContactGroup.getProperty("X-GOOGLE-RESOURCENAME"));
            if (undefined !== contactResourceNames) {
                for (let contactResourceName of contactResourceNames) {
                    let localContact = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", contactResourceName);
                    localContactGroupDirectory.addCard(localContact._card);
                }
                localContactGroupDirectory.editMailListToDatabase(localContactGroup);
            }
        }
    }

    static updateContactGroupMemberMap(contactGroupMemberMap, contactResourceName, contactMemberships) {
        if (null == contactGroupMemberMap) {
            throw new IllegalArgumentError("Invalid 'contactGroupMemberMap': null.");
        }
        if (null == contactResourceName) {
            throw new IllegalArgumentError("Invalid 'contactResourceName': null.");
        }
        if (null == contactMemberships) {
            throw new IllegalArgumentError("Invalid 'contactMemberships': null.");
        }
        // Cycle on all contact memberships.
        for (let contactMembership of contactMemberships) {
            // Discard useless items.
            if (undefined == contactMembership.contactGroupMembership) {
                continue;
            }
            // Retrieve the contact group resource name.
            let contactGroupResourceName = contactMembership.contactGroupMembership.contactGroupResourceName;
            // If such a contact group is not already in the map, add it and its contact array.
            if (null == contactGroupMemberMap.get(contactGroupResourceName)) {
                contactGroupMemberMap.set(contactGroupResourceName, []);
            }
            // Add the contact to the map.
            contactGroupMemberMap.get(contactGroupResourceName).push(contactResourceName);
        }
        //
        return contactGroupMemberMap;
    }

    /* Change log. */

    static async fixChangeLog(targetAddressBook) {
        if (null == targetAddressBook) {
            throw new IllegalArgumentError("Invalid 'targetAddressBook': null.");
        }
        // Cycle on all the items in the change log.
        logger.log0("AddressBookSynchronizer.synchronize(): Fixing the change log.");
        for (let item of targetAddressBook.getItemsFromChangeLog()) {
            // Retrieve the item id.
            let itemId = item.itemId;
            // Try to match the item locally.
            let localItem = await targetAddressBook.getItemFromProperty("X-GOOGLE-RESOURCENAME", itemId);
            // If it is not a valid local item...
            if (null == localItem) {
                // Remove the item id from the change log.
                await targetAddressBook.removeItemFromChangeLog(itemId);
                logger.log1("AddressBookSynchronizer.fixChangeLog(): " + itemId + " was removed from the change log.");
            }
        }
    }

}
