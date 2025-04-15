const express = require('express');
const fileUpload = require('express-fileupload');
const XLSX = require('xlsx');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// --- Database Configuration ---
// Ensure your .env file has: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', // Add defaults for safety
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Add timezone for consistency if needed, e.g. 'Z' for UTC
    // timezone: 'Z',
});

// --- Database Initialization ---
async function initializeDatabase() {
    let connection;
    try {
        connection = await pool.getConnection(); // Get connection for setup
        console.log("Connected to database for initialization.");

        // Ensure the `couples` table exists
        await connection.query(`
            CREATE TABLE IF NOT EXISTS couples (
                id INT AUTO_INCREMENT PRIMARY KEY,
                couple_no INT NOT NULL UNIQUE, -- Added UNIQUE constraint assuming couple_no is unique
                men_age INT NOT NULL,
                women_age INT NOT NULL,
                marriage_duration INT NOT NULL,
                travel_plan VARCHAR(255) NOT NULL,
                avg_age DECIMAL(5,2) GENERATED ALWAYS AS ((men_age + women_age) / 2.0) STORED, -- Use 2.0 for decimal division
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci; -- Good practice for encoding
        `);
        console.log("Table 'couples' checked/created.");

        // // Check and Add avg_age column (already handled by CREATE TABLE IF NOT EXISTS with generated column)
        // // The previous check was fine, but integrating into CREATE TABLE is cleaner if starting fresh or column definitely doesn't exist.
        // // If modifying an existing table without the generated column, the ALTER TABLE approach is needed.

        console.log("Database initialized successfully!");

    } catch (error) {
        console.error('Database initialization failed:', error);
        // Exit if critical setup fails
        process.exit(1);
    } finally {
        if (connection) connection.release(); // Always release connection
    }
}

// --- Middleware ---
// Serve static files (CSS, client-side JS) from 'public' directory
// If your CSS/JS are not in 'public', adjust this or remove it.
// For this project structure, it seems CSS/JS are inline or via CDN, so this might not be strictly needed.
app.use(express.static(path.join(__dirname, 'public')));

// Enable file uploads
app.use(fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    abortOnLimit: true,
    safeFileNames: true, // Helps prevent path traversal
    preserveExtension: true
}));

// Parse JSON request bodies
app.use(express.json());

// --- HTML Serving Routes ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/upload.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'upload.html'));
});

app.get('/analysis.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'analysis.html'));
});



// File Upload Route (Improved Validation)
app.post('/upload', async (req, res) => {
    if (!req.files?.surveyFile) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.files.surveyFile;
    const fileExtension = file.name.split('.').pop()?.toLowerCase(); // Optional chaining for safety

    if (!['xlsx', 'xls'].includes(fileExtension)) {
        return res.status(400).json({ error: 'Invalid file type. Only .xlsx or .xls are allowed.' });
    }

    let connection; // Define connection outside try for finally block
    try {
        connection = await pool.getConnection();
        console.log('Processing file:', file.name);

        const workbook = XLSX.read(file.data, { type: 'buffer' }); // Use buffer type
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!worksheet) {
            return res.status(400).json({ error: 'Excel file seems empty or sheet not found.' });
        }

        // Get header row
        const header = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0];
        const requiredColumns = ['Couple No', 'Men Age', 'Women Age', 'Marriage Duration', 'Travel Plan'];

        // More robust header validation
        const actualHeaders = header.map(h => String(h).trim()); // Trim whitespace
        const missingColumns = requiredColumns.filter(col => !actualHeaders.includes(col));

        if (missingColumns.length > 0) {
            console.log('Missing columns:', missingColumns);
            await connection.release(); // Release before sending response
            return res.status(400).json({
                error: `Missing required columns in Excel file: ${missingColumns.join(', ')}`,
                missing: missingColumns
            });
        }

        // Convert sheet to JSON using the found headers
        const rawData = XLSX.utils.sheet_to_json(worksheet);

        if (rawData.length === 0) {
             await connection.release();
             return res.status(400).json({ error: 'No data rows found in the Excel file.' });
        }

        // Data Validation (Example: Check if ages are numbers)
        for (const row of rawData) {
             if (isNaN(parseInt(row['Men Age'])) || isNaN(parseInt(row['Women Age'])) || isNaN(parseInt(row['Marriage Duration']))) {
                await connection.release();
                return res.status(400).json({ error: `Invalid non-numeric data found in age or duration columns for Couple No ${row['Couple No'] ?? 'Unknown'}.` });
             }
             if (!row['Travel Plan'] || String(row['Travel Plan']).trim() === '') {
                 await connection.release();
                 return res.status(400).json({ error: `Missing Travel Plan for Couple No ${row['Couple No'] ?? 'Unknown'}.`});
             }
        }


        // Database operations
        await connection.beginTransaction();

        // TRUNCATE is fast but irreversible. Consider alternatives if needed.
        await connection.query('TRUNCATE TABLE couples');
        console.log('Table "couples" truncated.');

        // Prepare values for batch insert, ensuring correct column mapping
        const values = rawData.map(row => [
            row['Couple No'],
            parseInt(row['Men Age']), // Ensure numbers are stored as integers
            parseInt(row['Women Age']),
            parseInt(row['Marriage Duration']),
            String(row['Travel Plan']).trim() // Trim whitespace from plan
        ]);

        const sql = `INSERT INTO couples
            (couple_no, men_age, women_age, marriage_duration, travel_plan)
            VALUES ?`;

        await connection.query(sql, [values]);
        console.log(`Inserted ${values.length} rows.`);

        await connection.commit();
        res.json({ success: true, message: `Successfully processed ${rawData.length} records.`, count: rawData.length });

    } catch (error) {
        if (connection) await connection.rollback(); // Rollback on error
        console.error('Upload processing error:', error);
        res.status(500).json({
            error: 'Processing failed due to an internal error.',
            details: error.message // Provide message for debugging
        });
    } finally {
        if (connection) connection.release(); // Ensure connection is always released
        console.log("Connection released after upload processing.");
    }
});

// Paginated Raw Data Route
app.get('/api/raw-data', async (req, res) => {
    let connection;
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        connection = await pool.getConnection();
        const [data] = await connection.query(
            'SELECT couple_no as `Couple No`, men_age as `Men Age`, women_age as `Women Age`, marriage_duration as `Marriage Age (years)`, travel_plan as `Travel Plan` FROM couples ORDER BY couple_no LIMIT ? OFFSET ?',
            [limit, offset]
        );

        const [totalResult] = await connection.query('SELECT COUNT(*) AS count FROM couples');
        const total = totalResult[0].count;

        res.json({
            data,
            total,
            page,
            limit, // Also return limit for context
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Raw data fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch raw data' });
    } finally {
        if (connection) connection.release();
    }
});

// --- Analysis Data Route (Expanded) ---
app.get('/api/analysis', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();

        // --- Overall Stats ---
        const [totalCouplesRes] = await connection.query('SELECT COUNT(*) AS count FROM couples');
        const totalCouples = totalCouplesRes[0].count;

        const [distinctPlansRes] = await connection.query('SELECT COUNT(DISTINCT travel_plan) AS count FROM couples');
        const totalPlans = distinctPlansRes[0].count;

        // --- Age Distribution (Overall) ---
        const [ageGroupsRes] = await connection.query(`
            SELECT
                CASE
                    WHEN avg_age < 25 THEN 'Under 25'
                    WHEN avg_age BETWEEN 25 AND 34.99 THEN '25-34' -- Use 34.99 for clarity
                    WHEN avg_age BETWEEN 35 AND 49.99 THEN '35-49' -- Use 49.99
                    ELSE '50+'
                END AS age_group,
                COUNT(*) AS count,
                ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage -- Calculate percentage
            FROM couples
            GROUP BY age_group
            ORDER BY MIN(avg_age); -- Order groups logically
        `);
        const ageDistribution = ageGroupsRes;


        // --- Older Couples Analysis (Example: Both partners >= 50) ---
        const [olderStats] = await connection.query(`
            SELECT
                AVG(marriage_duration) as avg_marriage_duration,
                COUNT(*) as count
            FROM couples
            WHERE men_age >= 50 AND women_age >= 50;
        `);

        const [olderPlansRes] = await connection.query(`
            SELECT travel_plan, COUNT(*) as count,
                   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
            FROM couples
            WHERE men_age >= 50 AND women_age >= 50
            GROUP BY travel_plan
            ORDER BY count DESC;
            -- LIMIT 6; -- Limit if needed for display
        `);
        const olderCouplesAnalysis = {
            count: olderStats[0].count || 0,
            avgMarriageDuration: olderStats[0].avg_marriage_duration ? parseFloat(olderStats[0].avg_marriage_duration).toFixed(1) : 'N/A',
            preferences: olderPlansRes
        };

        // --- Younger Couples Analysis (Example: Both partners < 35) ---
         const [youngerStats] = await connection.query(`
            SELECT
                AVG(marriage_duration) as avg_marriage_duration,
                COUNT(*) as count
            FROM couples
            WHERE men_age < 35 AND women_age < 35;
        `);

        const [youngerPlansRes] = await connection.query(`
            SELECT travel_plan, COUNT(*) as count,
                   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
            FROM couples
            WHERE men_age < 35 AND women_age < 35
            GROUP BY travel_plan
            ORDER BY count DESC;
            -- LIMIT 6; -- Limit if needed for display
        `);
         const youngerCouplesAnalysis = {
            count: youngerStats[0].count || 0,
            avgMarriageDuration: youngerStats[0].avg_marriage_duration ? parseFloat(youngerStats[0].avg_marriage_duration).toFixed(1) : 'N/A',
          preferences: youngerPlansRes
        };

        // --- Marriage Duration Analysis ---
        const [shortMarriageStats] = await connection.query(`
            SELECT
                AVG(marriage_duration) as avg_marriage_duration,
                COUNT(*) as count
            FROM couples
            WHERE marriage_duration < 10;
        `);

        const [shortMarriagePlansRes] = await connection.query(`
            SELECT travel_plan, COUNT(*) as count,
                   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
            FROM couples
            WHERE marriage_duration < 10
            GROUP BY travel_plan
            ORDER BY count DESC;
            -- LIMIT 6; -- Limit if needed for display
        `);
         const shortMarriageAnalysis = {
            count: shortMarriageStats[0].count || 0,
            avgMarriageDuration: shortMarriageStats[0].avg_marriage_duration ? parseFloat(shortMarriageStats[0].avg_marriage_duration).toFixed(1) : 'N/A',
            preferences: shortMarriagePlansRes
        };

        const [longMarriageStats] = await connection.query(`
            SELECT
                AVG(marriage_duration) as avg_marriage_duration,
                COUNT(*) as count
            FROM couples
            WHERE marriage_duration >= 10;
        `);

        const [longMarriagePlansRes] = await connection.query(`
            SELECT travel_plan, COUNT(*) as count,
                   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
            FROM couples
            WHERE marriage_duration >= 10
            GROUP BY travel_plan
            ORDER BY count DESC;
            -- LIMIT 6; -- Limit if needed for display
        `);
         const longMarriageAnalysis = {
            count: longMarriageStats[0].count || 0,
            avgMarriageDuration: longMarriageStats[0].avg_marriage_duration ? parseFloat(longMarriageStats[0].avg_marriage_duration).toFixed(1) : 'N/A',
            preferences: longMarriagePlansRes
        };


        // --- Overall Plan Popularity (Top and Bottom) ---
        const [allPlansPopularity] = await connection.query(`
            SELECT travel_plan, COUNT(*) as count
            FROM couples
            GROUP BY travel_plan
            ORDER BY count DESC;
        `);

        const mostLikedOverall = allPlansPopularity.length > 0 ? allPlansPopularity[0] : { travel_plan: 'N/A', count: 0 };
        const leastLikedOverall = allPlansPopularity.length > 0 ? allPlansPopularity[allPlansPopularity.length - 1] : { travel_plan: 'N/A', count: 0 };

        // We interpret "disliked" as least popular among all choices for this example.
        // A real survey might have a "dislike" score.
        const dislikedPlans = [...allPlansPopularity].sort((a, b) => a.count - b.count).slice(0, 5); // Get bottom 5

        // --- Summary Findings ---
        const summary = {
            olderFavorite: olderCouplesAnalysis.preferences.length > 0 ? olderCouplesAnalysis.preferences[0].travel_plan : 'N/A',
            youngerFavorite: youngerCouplesAnalysis.preferences.length > 0 ? youngerCouplesAnalysis.preferences[0].travel_plan : 'N/A',
            // Using least popular overall as "most disliked"
            allDisliked: dislikedPlans.length > 0 ? dislikedPlans[0].travel_plan : 'N/A',
        };

        res.json({
            totalCouples,
            totalPlans,
            lastUpdated: new Date().toLocaleString(), // More readable format
            ageDistribution, // Overall age distribution
            olderCouplesAnalysis,
            youngerCouplesAnalysis,
            dislikedPlans, // Least popular overall (bottom 5)
            summary, // Specific findings for summary cards
            shortMarriageAnalysis,
            longMarriageAnalysis,
            allPlansPopularity // Full list if needed by 'All Couples' tab chart
        });

    } catch (error) {
        console.error('Analysis data fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch analysis data', details: error.message });
    } finally {
        if (connection) connection.release();
    }
});


// --- Test DB Connection Route ---
app.get('/test-db', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [result] = await connection.query('SELECT 1 + 1 AS solution');
        res.json({ success: true, message: 'Database connection successful!', result: result[0].solution });
    } catch (error) {
        console.error('DB Test Error:', error);
        res.status(500).json({ error: 'DB connection failed', details: error.message });
    } finally {
        if (connection) connection.release();
    }
});

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err); // Log the full error stack

    // Handle file upload size limit error specifically
    if (err.code === 'LIMIT_FILE_SIZE') {
       return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
    }

    // Generic error response
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// --- Server Initialization ---
// Initialize DB first, then start listening
initializeDatabase().then(() => {
    app.listen(port, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}).catch(err => {
    console.error("Failed to initialize database before starting server:", err);
    process.exit(1); // Exit if DB init fails fundamentally
});
