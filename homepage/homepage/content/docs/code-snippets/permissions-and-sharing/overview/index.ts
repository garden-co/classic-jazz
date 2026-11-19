// #region Basic
import { Group } from "jazz-tools";

const group = Group.create();
// #endregion

import type { Account, ID } from "jazz-tools";

const bobsId = "";
// #region AddMember
import { co } from "jazz-tools";
const bob = await co.account().load(bobsId);

if (bob.$isLoaded) {
  group.addMember(bob, "writer");
}
// #endregion

// #region ChangeRole
if (bob.$isLoaded) {
  group.addMember(bob, "reader");
}
// #endregion

// #region ListMembers
// All members, including the ones inherited from parent groups
for (const member of group.members) {
  console.log(member.id, member.role);
}

// Only the members that were added to this group itself
const directMembers = group.getDirectMembers();
// #endregion

// #region GetRole
// The role of the current account in this group
const myRole = group.myRole();

// The role of any account, looked up by its ID ("me" and "everyone" also work)
const bobsRole = group.getRoleOf(bobsId as ID<Account>);
const everyoneRole = group.getRoleOf("everyone");

if (bobsRole === "admin") {
  console.log("Bob is an admin");
}
// #endregion

// #region RemoveMember
if (bob.$isLoaded) {
  group.removeMember(bob);
}
// #endregion

import { createJazzTestAccount } from "jazz-tools/testing";
import { z } from "jazz-tools";
const existingCoValue = await createJazzTestAccount();

const MyCoMap = co.map({
  color: z.string(),
});

// #region GetGroup
const owningGroup = existingCoValue.$jazz.owner;
const newValue = MyCoMap.create({ color: "red" }, { owner: group });
// #endregion

// #region CheckPermissions
const red = MyCoMap.create({ color: "red" });
const me = co.account().getMe();

if (me.canAdmin(red)) {
  console.log("I can add users of any role");
} else if (me.canManage(red)) {
  console.log("I can share value with others");
} else if (me.canWrite(red)) {
  console.log("I can edit value");
} else if (me.canRead(red)) {
  console.log("I can view value");
} else {
  console.log("I cannot access value");
}
// #endregion

const alicesId = "";

// #region CheckPermissionsAlice
const blue = MyCoMap.create({ color: "blue" });
const alice = await co.account().load(alicesId);

if (alice.$isLoaded) {
  if (alice.canAdmin(blue)) {
    console.log("Alice can share value with others");
  } else if (alice.canWrite(blue)) {
    console.log("Alice can edit value");
  } else if (alice.canRead(blue)) {
    console.log("Alice can view value");
  } else {
    console.log("Alice cannot access value");
  }
}
// #endregion

// #region DefinePermissionsAtSchemaLevel
const Dog = co.map({
  name: z.string(),
}).withPermissions({
  onInlineCreate: "sameAsContainer",
});
const Person = co.map({
  pet: Dog,
}).withPermissions({
  default: () => Group.create().makePublic(),
});

// All Person CoValues will be public, and each Dog CoValue will share the same owner
// as the Person that references it.
const person = Person.create({
  pet: {
    name: "Rex",
  },
});
// #endregion

// #region SetDefaultSchemaPermissions
import { setDefaultSchemaPermissions } from "jazz-tools";

setDefaultSchemaPermissions({
  onInlineCreate: "sameAsContainer",
});
// #endregion
