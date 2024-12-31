import { Image, StyleSheet, Platform } from "react-native";

import { HelloWave } from "@/components/HelloWave";
import ParallaxScrollView from "@/components/ParallaxScrollView";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import React, { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import * as Contacts from "expo-contacts";
import * as SQLite from "expo-sqlite";

const db = SQLite.openDatabaseSync("contacts.db");

export default function HomeScreen() {
  const [contacts, setContacts] = useState<string[]>([]);

  useEffect(() => {
    const createTable = () => {
      const statement = db.prepareSync(
        "CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);"
      );
      try {
        statement.executeSync();
        console.log("Table created (or already exists).");
      } finally {
        statement.finalizeSync();
      }
    };
  
    createTable();
  }, []);

  const importContacts = async () => {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status === "granted") {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name],
      });
  
      if (data.length > 0) {
        const insertStatement = db.prepareSync(
          "INSERT OR IGNORE INTO contacts (name) VALUES (?)"
        );
        try {
          for (const contact of data) {
            if (contact.name) {
              insertStatement.executeSync(contact.name);
            }
          }
          console.log("Contacts imported (new ones only)!");
        } finally {
          insertStatement.finalizeSync();
        }
      }
    }
  };
  
  const fetchContacts = () => {
    const statement = db.prepareSync("SELECT * FROM contacts");
    try {
      const result = statement.executeSync<{ name: string }>();
      const allRows = result.getAllSync();
      const names = allRows.map((row) => row.name);

      setContacts(names);
      console.log("Fetched rows:", names);
    } finally {
      statement.finalizeSync();
    }
  };

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: "#A1CEDC", dark: "#1D3D47" }}
      headerImage={
        <Image
          source={require("@/assets/images/partial-react-logo.png")}
          style={styles.reactLogo}
        />
      }
    >
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title">Welcome!</ThemedText>
        <HelloWave />
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Step 3: Get a fresh start</ThemedText>
        <ThemedText>When you're ready, run </ThemedText>
        <Button title="Insert Contacts" onPress={importContacts} />
        <Button title="Fetch Contacts" onPress={fetchContacts} />
      </ThemedView>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stepContainer: {
    gap: 8,
    marginBottom: 8,
  },
  reactLogo: {
    height: 178,
    width: 290,
    bottom: 0,
    left: 0,
    position: "absolute",
  },
});
