import React, { useState, useEffect } from "react";
import { FlatList, StyleSheet, Text, View, Image, Button } from "react-native";
import * as Contacts from "expo-contacts";
import * as SQLite from "expo-sqlite";
import OpenAI from "openai";

// ---------------
// 1) OPEN THE DB
// ---------------
const db = SQLite.openDatabaseSync("contacts.db");

// ---------------
// 2) HOME SCREEN
// ---------------
export default function HomeScreen() {
  const [allContacts, setAllContacts] = useState<ContactWithTags[]>([]);

  useEffect(() => {
    const clearDatabase = () => {
      db.prepareSync("DROP TABLE IF EXISTS contacts;").executeSync();
      db.prepareSync("DROP TABLE IF EXISTS tags;").executeSync();
      db.prepareSync("DROP TABLE IF EXISTS contact_tags;").executeSync();
      console.log("All tables cleared.");
    };
    clearDatabase();

    initializeDB();
  }, []);

  // ----------------------------------
  // SCHEMA: contacts, tags, contact_tags
  // ----------------------------------
  const initializeDB = async () => {
    try {
      // CREATE/UPDATE the main "contacts" table
      db.prepareSync(
        `
        CREATE TABLE IF NOT EXISTS contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          -- The phone's unique contact identifier (like contact.id in expo-contacts)
          true_id TEXT UNIQUE,
          name TEXT,
          company TEXT,
          jobTitle TEXT,
          rawImage BLOB,
          imageAvailable INTEGER
        );
      `
      ).executeSync();

      // CREATE the "tags" table
      const prp = db.prepareSync(`
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE
        );
      `);
      const exec = db
        .prepareSync(
          `
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE
        );
      `
        )
        .executeSync();
      prp.finalizeSync();

      // CREATE the many-to-many "contact_tags" table
      const prepare_mm = db.prepareSync(
        `
        CREATE TABLE IF NOT EXISTS contact_tags (
          contact_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          PRIMARY KEY (contact_id, tag_id),
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
      `
      );
      const exec_mm = prepare_mm.executeSync();
      prepare_mm.finalizeSync();

      console.log("All tables created (or already exist).");

      // After DB init, import contacts, then fetch them
      await importContacts();

      fetchContacts();
    } catch (error) {
      console.error("DB initialization error:", error);
    }
  };

  // ------------------------------------------
  // 3) DETECT NEW/EDITED CONTACTS & IMPORT THEM
  // ------------------------------------------
  // We'll fetch the device contacts, compare them to local DB,
  // and only send new/edited ones to a "dummy AI" function.

  const importContacts = async () => {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== "granted") {
      console.warn("Contacts permission not granted.");
      return;
    }

    // Request fields: name, company, jobTitle, imageAvailable
    // (Though not all devices will have them.)
    const { data } = await Contacts.getContactsAsync({
      fields: [
        Contacts.Fields.Name,
        Contacts.Fields.Company,
        Contacts.Fields.JobTitle,
        Contacts.Fields.ImageAvailable,
      ],
      pageSize: 1000, // or appropriate paging
    });

    if (!data || data.length === 0) {
      console.log("No device contacts found.");
      return;
    }

    // 1) For each device contact, check if it's new or edited
    //    We'll gather them in an array to process with AI
    const newOrEdited: Contacts.Contact[] = [];
    for (const c of data) {
      if (!c.id) continue; // skip if no ID
      const changed = checkIfContactChanged(c);
      if (changed) {
        newOrEdited.push(c);
      }
    }

    if (newOrEdited.length === 0) {
      console.log("No new or edited contacts found. Nothing to process.");
      return;
    }

    // 2) Call the AI (dummy) with that list
    //    In real usage, you'd pass name, company, jobTitle, plus existing tags, etc.
    const current_tags = getAllTags();
    console.log("New Extraction.");
    const extractedTagInfo = await extractTagsFromAI(newOrEdited, current_tags);

    // 3) Insert or update these contacts + their tags in one transaction
    db.withTransactionSync(() => {
      // Insert/update each new or edited contact in "contacts"
      for (const c of newOrEdited) {
        upsertContact(c);
      }

      // For each contact in the AI result, insert new tags and link them
      for (const item of extractedTagInfo) {
        const { true_id, tags } = item;
        // 1) get the DB contact id from "true_id"
        const contactDbId = getContactDbId(true_id);
        if (!contactDbId) continue;

        // 2) for each tag, upsert it in "tags", then link
        for (const tagName of tags) {
          const tagId = upsertTag(tagName);
          linkContactToTag(contactDbId, tagId);
        }
      }
    });

    console.log("Imported/Updated new contacts + tags!");
  };

  // --------------------------------
  // 3A) CHECK IF CONTACT IS NEW/EDITED
  // --------------------------------
  const checkIfContactChanged = (c: Contacts.Contact) => {
    // We'll do a quick SELECT from 'contacts' by true_id
    const stmt = db.prepareSync(`
      SELECT name, company, jobTitle, imageAvailable FROM contacts
      WHERE true_id = ? LIMIT 1
    `);
    try {
      if (!c.id) {
        return true;
      }
      const exec = stmt.executeSync(c.id);
      const row = exec.getFirstSync() as LocalContact;
      if (!row) {
        // Means not found => new contact
        return true;
      }
      // Compare name, company, jobTitle, imageAvailable
      const hasNameChanged = (row.name.trim() || "") !== (c.name?.trim() || "");
      const hasCompanyChanged =
        (row.company.trim() || "") !== (c.company?.trim() || "");
      const hasJobChanged =
        (row.jobTitle.trim() || "") !== (c.jobTitle?.trim() || "");
      // imageAvailable is 0 or 1 in DB, but boolean in expo
      const dbImgAvail = row.imageAvailable === 1;
      const hasImageChanged = dbImgAvail !== (c.imageAvailable || false);
      return (
        hasNameChanged || hasCompanyChanged || hasJobChanged || hasImageChanged
      );
    } finally {
      stmt.finalizeSync();
    }
  };

  // --------------------------------
  // 3B) UPSERT CONTACT IN DB
  // --------------------------------
  const upsertContact = (c: Contacts.Contact) => {
    // We'll store name, company, jobTitle, imageAvailable
    // "INSERT OR REPLACE" effectively updates if true_id already exists
    const stmt = db.prepareSync(`
      INSERT OR REPLACE INTO contacts (id, true_id, name, company, jobTitle, imageAvailable)
      VALUES (
        (SELECT id FROM contacts WHERE true_id = ?),
        ?, ?, ?, ?, ?
      );
    `);
    if (!c.id) {
      return;
    }
    try {
      // imageAvailable is boolean => store as 0/1
      const imgVal = c.imageAvailable ? 1 : 0;
      stmt.executeSync(
        c.id, // subselect param for existing row
        c.id, // true_id
        c.name?.trim() || "",
        c.company?.trim() || "",
        c.jobTitle?.trim() || "",
        imgVal
      );
    } finally {
      stmt.finalizeSync();
    }
  };

  // --------------------------
  // 3C) GET CONTACT's DB ID
  // --------------------------
  const getContactDbId = (true_id: string | undefined) => {
    if (!true_id) {
      return null;
    }
    const stmt = db.prepareSync(
      `SELECT id FROM contacts WHERE true_id = ? LIMIT 1;`
    );
    try {
      const exec = stmt.executeSync(true_id);
      const row = exec.getFirstSync() as LocalContact;
      return row ? row.id : null;
    } finally {
      stmt.finalizeSync();
    }
  };

  // --------------------------
  // 3D) UPSERT TAG
  // --------------------------
  const upsertTag = (tagName: string) => {
    // We'll do a quick SELECT. If not found, insert. Then return id.
    tagName = tagName.trim();
    if (!tagName) return null;

    // 1) Check if exists
    let stmt = db.prepareSync(`SELECT id FROM tags WHERE name = ? LIMIT 1;`);
    let row;
    try {
      row = stmt.executeSync(tagName).getFirstSync() as LocalContact;
    } finally {
      stmt.finalizeSync();
    }
    if (row && row.id) {
      return row.id;
    }

    // 2) Insert new
    stmt = db.prepareSync(`INSERT INTO tags (name) VALUES (?);`);
    try {
      const result = stmt.executeSync(tagName);
      // The `lastInsertRowId` should give us the new tag's ID
      return result.lastInsertRowId;
    } finally {
      stmt.finalizeSync();
    }
  };

  // --------------------------
  // 3E) LINK CONTACT TO TAG
  // --------------------------
  const linkContactToTag = (contact_id: number, tag_id: number | null) => {
    if (!contact_id || !tag_id) return;
    // Insert or ignore (PRIMARY KEY (contact_id, tag_id) will enforce uniqueness)
    const stmt = db.prepareSync(`
      INSERT OR IGNORE INTO contact_tags (contact_id, tag_id)
      VALUES (?, ?);
    `);
    try {
      stmt.executeSync(contact_id, tag_id);
    } finally {
      stmt.finalizeSync();
    }
  };

  // --------------------------
  // 3F) DUMMY AI EXTRACTION
  // --------------------------
  // In reality, you'd pass the name, company, jobTitle, plus existing tag list to your LLM
  // and get back an array of relevant tags. For now, it's just a "Hello" placeholder.
  const extractTagsFromAI = async (
    contacts: Contacts.Contact[],
    existingTags: string[]
  ) => {
    const openai = new OpenAI({
      apiKey: "<KEY>", // Replace with your actual API key
      baseURL: "https://api.deepseek.com", // Use the correct base URL
    });

    const systemPrompt: string = `
    You are an intelligent assistant that specializes in categorizing and tagging contact information. Your task is to extract meaningful and relevant tags for a list of contacts based on their name, company, and job title. Most users embed affiliations or tags directly into the contact's name, so it is critical to analyze the \`name\` field carefully for identifying affiliations, industries, or communities.
    
    IMPORTANT NOTES:
    1. You will receive a list of contacts, each containing:
       - A unique \`true_id\`.
       - A \`name\` (this often includes affiliations or tags directly).
       - A \`company\`.
       - A \`jobTitle\`.
    
    2. You will also receive a list of existing tags. Use these to:
       - Standardize tag generation (e.g., "Intel" and "Intel Company" should resolve to "Intel").
       - Avoid creating duplicates.
       New tags are allowed but must be concise, relevant, and non-redundant.
    
    3. Never generate tags that include personal data such as phone numbers, email addresses, or unrelated identifiers.
    
    4. Always return valid JSON. Each contact must include:
       - The \`true_id\` (for identification purposes).
       - An array of extracted \`tags\`.
    
    EXAMPLES OF TAGGING:
    
    Example Input:
    {
      "contacts": [
        {
          "true_id": "12345",
          "name": "Jane Smith Intel",
          "company": "Intel",
          "jobTitle": "Software Engineer"
        },
        {
          "true_id": "67890",
          "name": "Fahad Misk",
          "company": "",
          "jobTitle": "Volunteer"
        },
        {
          "true_id": "54321",
          "name": "Michael Ruby-on-Rails",
          "company": "Tech Innovators",
          "jobTitle": "Backend Developer"
        }
      ],
      "existing_tags": ["Intel", "Tech", "Misk Fellowship", "Ruby on Rails"]
    }
    
    Example Output:
    [
      {
        "true_id": "12345",
        "tags": ["Intel", "Tech", "Software Engineering"]
      },
      {
        "true_id": "67890",
        "tags": ["Misk Fellowship", "Volunteer Work", "Community"]
      },
      {
        "true_id": "54321",
        "tags": ["Ruby on Rails", "Tech", "Backend Development"]
      }
    ]
    
    GUIDELINES FOR TAG GENERATION:
    1. Extract from Name:
       - Assume the \`name\` field often contains affiliations, industries, or communities directly.
       - For example:
         - "Naif Aviation Club" → Tags: ["Aviation Club", "Naif"]
         - "Fahad Misk" → Tags: ["Misk Fellowship"]
         - "Mike UCLA" → Tags: ["UCLA"]
         - "Michael Ruby-on-Rails" → Tags: ["Ruby on Rails"]
    
    2. Extract from Company:
       - Use the name of the company as a tag if provided.
       - Example: "Intel" → ["Intel"]
    
    3. Extract from Job Title:
       - Generate tags for professions or roles.
       - Example: "Software Engineer" → ["Software Engineering"]
    
    4. Avoid Redundancy:
       - If the same tag appears in both \`name\` and \`company\`, only include it once.
    
    5. Use Existing Tags:
       - Match tags against the provided \`existing_tags\` to standardize naming (e.g., "Misk Fellow" → "Misk Fellowship").
    
    6. Always Return Valid JSON:
       - If no meaningful tags can be extracted, return an empty array for \`tags\`.
    `;

    const batchSize = 35; // Batch size
    let allExtractedTags: { true_id: string; tags: string[] }[] = []; // Accumulate results
  
    for (let i = 0; i < contacts.length; i += batchSize) {
      const batch = contacts.slice(i, i + batchSize);
  
      // Prepare the user input with contact data and existing tags
      const contactInput = {
        contacts: batch.map((c) => ({
          true_id: c.id,
          name: c.name || "",
          company: c.company || "",
          jobTitle: c.jobTitle || "",
        })),
        existing_tags: existingTags, // Use the existing tags up to this point
      };
  
      console.log("Sending to AI:", JSON.stringify(contactInput));
  
      try {
        // Send the batch to AI
        const response = await openai.chat.completions.create({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `INPUT: ${JSON.stringify(contactInput)}` },
          ],
          response_format: { type: "json_object" },
        });
  
        // Log raw response for debugging
        console.log("Raw AI Response:", response.choices[0].message.content);
  
        // Parse the response safely
        let extractedTags: { true_id: string; tags: string[] }[] = [];
        try {
          if(!response.choices[0].message.content){
            throw new Error("sad");
          }
          const rawResponse = JSON.parse(response.choices[0].message.content);
  
          // Validate the structure of the response
          if (!rawResponse || !Array.isArray(rawResponse.contacts)) {
            throw new Error("Malformed response structure.");
          }
  
          // Ensure all `tags` fields are arrays
          extractedTags = rawResponse.contacts.map((contact: any) => ({
            true_id: contact.true_id,
            tags: Array.isArray(contact.tags) ? contact.tags : [], // Ensure `tags` is an array
          }));
        } catch (error) {
          console.error("Failed to parse or validate AI response:", error);
          continue; // Skip this batch and move to the next one
        }
  
        console.log("Extracted Tags for Batch:", extractedTags);
  
        // Append extracted tags to the full list
        allExtractedTags = allExtractedTags.concat(extractedTags);
  
        // Update `existingTags` with any new tags from the batch
        extractedTags.forEach((contact) => {
          contact.tags.forEach((tag) => {
            if (!existingTags.includes(tag)) {
              existingTags.push(tag); // Add unique tags to the list
            }
          });
        });
      } catch (error) {
        console.error("Failed to process batch:", error);
      }
    }
  
    // Return the full list of extracted tags after all batches
    return allExtractedTags;
  };
  
  // ----------------------------------
  // 4) FETCH CONTACTS & SHOW IN UI
  // ----------------------------------

  const fetchContacts = () => {
    const stmt = db.prepareSync(`
      SELECT 
        c.id,
        c.name,
        GROUP_CONCAT(t.name, ', ') AS tags
      FROM contacts c
      LEFT JOIN contact_tags ct ON c.id = ct.contact_id
      LEFT JOIN tags t ON ct.tag_id = t.id
      GROUP BY c.id
      ORDER BY c.name ASC;
    `);

    try {
      const result = stmt.executeSync();
      const rows = result.getAllSync() as ContactWithTags[];

      console.log(rows);
      const mapped = rows.map((row) => ({
        id: row.id,
        name: row.name,
        tags: row.tags ? row.tags : [],
      }));

      setAllContacts(mapped);
      console.log("Fetched contacts with tags!");
    } finally {
      stmt.finalizeSync();
    }
  };
  // const fetchContacts = () => {
  //   // We do a LEFT JOIN to get tags, then GROUP_CONCAT them.
  //   // Each row in the result will contain a combined CSV string of tag names (tagsString).
  //   const stmt = db.prepareSync(`
  //     SELECT
  //       c.id,
  //       c.true_id,
  //       c.name,
  //       c.company,
  //       c.jobTitle,
  //       c.imageAvailable,
  //       GROUP_CONCAT(t.name, ',') as tagsString
  //     FROM contacts c
  //     LEFT JOIN contact_tags ct ON c.id = ct.contact_id
  //     LEFT JOIN tags t ON ct.tag_id = t.id
  //     GROUP BY c.id
  //     ORDER BY c.name ASC
  //   `);

  //   try {
  //     const result = stmt.executeSync<{
  //       id: number;
  //       true_id: string;
  //       name: string;
  //       company: string;
  //       jobTitle: string;
  //       imageAvailable: number;
  //       tagsString: string | null;
  //     }>();
  //     const rows = result.getAllSync();

  //     // Convert the CSV of tags into a string array
  //     const mapped: LocalContact[] = rows.map((row) => {
  //       const splitTags = row.tagsString
  //         ? row.tagsString.split(",").map((s) => s.trim())
  //         : [];
  //       return {
  //         id: row.id,
  //         true_id: row.true_id,
  //         name: row.name,
  //         company: row.company,
  //         jobTitle: row.jobTitle,
  //         imageAvailable: row.imageAvailable,
  //         tags: splitTags,
  //       };
  //     });

  //     setAllContacts(mapped);
  //     console.log("Fetched contacts from DB:", mapped.length);
  //   } finally {
  //     stmt.finalizeSync();
  //   }
  // };

  // ------------------------------------------
  // RENDERING: A simple FlatList of our contacts
  // ------------------------------------------
  const onFetchPress = () => {
    fetchContacts();
  };

  // 5) Render each contact, including tags
  const renderContact = ({ item }: { item: ContactWithTags }) => {
    if (!item.name) return null;

    return (
      <View style={styles.contactItem}>
        <Text style={styles.contactText}>{item.name}</Text>
        <Text style={styles.tagsLine}>
          Tags: {item.tags.length > 0 ? item.tags : "None"}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={allContacts}
        renderItem={renderContact}
        contentContainerStyle={styles.listContainer}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No contacts found. Please import them!
          </Text>
        }
      />
    </View>
  );
}

// ---------------------------
// TYPES & STYLES
// ---------------------------

// Represents a contact as returned by expo-contacts
interface LocalContact {
  id: number;
  true_id: string;
  name: string;
  company: string;
  jobTitle: string;
  imageAvailable: number; // stored as 0 or 1 in the DB
  tags: string[]; // new property to display all tags
}

interface ContactWithTags {
  id: number;
  name: string; // The name of the contact
  tags: string[]; // Comma-separated list of tags or null if no tags
}

interface Tag {
  id: number;
  name: string;
}

interface ExpoContact {
  id: string;
  name?: string;
  company?: string;
  jobTitle?: string;
  imageAvailable?: boolean;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: "15%",
    padding: 16,
    backgroundColor: "#A1CEDC",
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginVertical: 8,
  },
  listContainer: {
    padding: 16,
  },
  contactItem: {
    padding: 12,
    marginVertical: 4,
    backgroundColor: "#f0f0f0",
    borderRadius: 8,
  },
  contactText: {
    fontSize: 16,
    fontWeight: "500",
    marginBottom: 4,
  },
  tagsLine: {
    marginTop: 4,
    fontStyle: "italic",
  },
  emptyText: {
    textAlign: "center",
    fontSize: 16,
    color: "#888",
    marginTop: 16,
  },
});

const getAllTags = () => {
  const stmt = db.prepareSync(`SELECT name FROM tags;`);
  try {
    const result = stmt.executeSync();
    const rows = result.getAllSync() as Tag[]; // Fetch all rows
    return rows.map((row) => row.name); // Return an array of tag names
  } finally {
    stmt.finalizeSync();
  }
};
