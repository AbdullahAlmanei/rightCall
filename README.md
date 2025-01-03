# Smart Contact Manager

Smart Contact Manager is an AI-powered contact management app that helps you organize, tag, and search through your phone contacts with ease. It uses OpenAI's GPT model to extract meaningful tags from your contacts based on their names, job titles, and affiliations.

---

## **Features**

- **AI Tag Extraction**: Automatically generate tags for contacts using AI.
- **Tag-Based Search**: Search contacts by industries, professions, or communities using generated tags.
- **Local Storage**: Save contacts and tags in a local SQLite database for fast and secure access.
- **Auto-Update**: Detect and update edited or newly added contacts.
- **User-Friendly Interface**: Intuitive design with React Native and Expo.

---

## **Tech Stack**

- **Frontend**: React Native with Expo
- **Backend**: SQLite for local data management
- **AI Integration**: OpenAI (DeepSeek API) for intelligent tag extraction
- **Languages**: TypeScript and JavaScript

---

## **Installation**
1. Clone the repository:
   ```bash
   git clone https://github.com/AbdullahAlmanei/rightCall.git
   cd rightCall
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   expo start
   ```
4. Scan the QR code with the Expo Go app on your phone to test the app.

---

## **Usage**

1. Launch the app and grant permission to access your contacts.
2. The app will scan your phone contacts and use AI to generate relevant tags.
3. Use the search feature to find contacts by name, job title, company, or tags.
4. Add or edit tags manually for finer control over your contacts.

---

## **Future Improvements**

- Implement degrees of separation for contacts.
- Add cloud synchronization to backup and restore contacts.
- Enable bulk tag editing for multiple contacts.
- Enhance AI prompt handling for better tag standardization.
---
