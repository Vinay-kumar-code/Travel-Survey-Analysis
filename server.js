const express = require('express');
const fileUpload = require('express-fileupload');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');
const path = require('path');
const compression = require('compression');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Simple in-memory cache for analysis data
let analysisCache = null;
let analysisCacheTime = null;
const CACHE_DURATION = 60000; // 1 minute cache

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', 
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_men_age (men_age),
                INDEX idx_women_age (women_age),
                INDEX idx_marriage_duration (marriage_duration),
                INDEX idx_travel_plan (travel_plan),
                INDEX idx_avg_age (avg_age)
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
// Enable gzip compression for responses
app.use(compression());

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

        // Use ExcelJS to read the workbook
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(file.data);
        
        const worksheet = workbook.worksheets[0];
        if (!worksheet) {
            return res.status(400).json({ error: 'Excel file seems empty or sheet not found.' });
        }

        // Get header row
        const headerRow = worksheet.getRow(1);
        const headers = [];
        headerRow.eachCell({ includeEmpty: false }, (cell) => {
            headers.push(String(cell.value).trim());
        });

        const requiredColumns = ['Couple No', 'Men Age', 'Women Age', 'Marriage Duration', 'Travel Plan'];

        // More robust header validation
        const missingColumns = requiredColumns.filter(col => !headers.includes(col));

        if (missingColumns.length > 0) {
            console.log('Missing columns:', missingColumns);
            await connection.release(); // Release before sending response
            return res.status(400).json({
                error: `Missing required columns in Excel file: ${missingColumns.join(', ')}`,
                missing: missingColumns
            });
        }

        // Convert worksheet to array of objects
        const rawData = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header row
            
            const rowData = {};
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const header = headers[colNumber - 1];
                if (header) {
                    rowData[header] = cell.value;
                }
            });
            
            // Only add row if it has data
            if (Object.keys(rowData).length > 0) {
                rawData.push(rowData);
            }
        });

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
        
        // Invalidate analysis cache when new data is uploaded
        analysisCache = null;
        analysisCacheTime = null;
        console.log('Analysis cache invalidated');
        
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

// Paginated Raw Data Route (Optimized)
app.get('/api/raw-data', async (req, res) => {
    let connection;
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        connection = await pool.getConnection();
        
        // Use a single query with subquery for total count (more efficient than separate query)
        const [results] = await connection.query(`
            SELECT 
                couple_no as \`Couple No\`, 
                men_age as \`Men Age\`, 
                women_age as \`Women Age\`, 
                marriage_duration as \`Marriage Age (years)\`, 
                travel_plan as \`Travel Plan\`,
                (SELECT COUNT(*) FROM couples) as total_count
            FROM couples 
            ORDER BY couple_no 
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        const data = results.map(row => {
            const { total_count, ...rowData } = row;
            return rowData;
        });
        
        const total = results.length > 0 ? results[0].total_count : 0;

        res.json({
            data,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Raw data fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch raw data' });
    } finally {
        if (connection) connection.release();
    }
});

// --- Analysis Data Route (Optimized with single query and caching) ---
app.get('/api/analysis', async (req, res) => {
    // Check cache first
    const now = Date.now();
    if (analysisCache && analysisCacheTime && (now - analysisCacheTime) < CACHE_DURATION) {
        console.log('Returning cached analysis data');
        return res.json(analysisCache);
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Optimized: Use a single query with CTEs to gather all statistics at once
        const [results] = await connection.query(`
            WITH 
            overall_stats AS (
                SELECT 
                    COUNT(*) as total_couples,
                    COUNT(DISTINCT travel_plan) as total_plans
                FROM couples
            ),
            age_groups AS (
                SELECT
                    CASE
                        WHEN avg_age < 25 THEN 'Under 25'
                        WHEN avg_age BETWEEN 25 AND 34.99 THEN '25-34'
                        WHEN avg_age BETWEEN 35 AND 49.99 THEN '35-49'
                        ELSE '50+'
                    END AS age_group,
                    COUNT(*) AS count,
                    ROUND(COUNT(*) * 100.0 / (SELECT total_couples FROM overall_stats), 1) as percentage
                FROM couples
                GROUP BY age_group
                ORDER BY MIN(avg_age)
            ),
            older_stats AS (
                SELECT
                    'older' as category,
                    COUNT(*) as count,
                    AVG(marriage_duration) as avg_marriage_duration
                FROM couples
                WHERE men_age >= 50 AND women_age >= 50
            ),
            older_plans AS (
                SELECT 
                    'older' as category,
                    travel_plan, 
                    COUNT(*) as count,
                    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT count FROM older_stats), 0), 1) as percentage
                FROM couples
                WHERE men_age >= 50 AND women_age >= 50
                GROUP BY travel_plan
                ORDER BY count DESC
            ),
            younger_stats AS (
                SELECT
                    'younger' as category,
                    COUNT(*) as count,
                    AVG(marriage_duration) as avg_marriage_duration
                FROM couples
                WHERE men_age < 35 AND women_age < 35
            ),
            younger_plans AS (
                SELECT 
                    'younger' as category,
                    travel_plan, 
                    COUNT(*) as count,
                    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT count FROM younger_stats), 0), 1) as percentage
                FROM couples
                WHERE men_age < 35 AND women_age < 35
                GROUP BY travel_plan
                ORDER BY count DESC
            ),
            short_marriage_stats AS (
                SELECT
                    'short' as category,
                    COUNT(*) as count,
                    AVG(marriage_duration) as avg_marriage_duration
                FROM couples
                WHERE marriage_duration < 10
            ),
            short_marriage_plans AS (
                SELECT 
                    'short' as category,
                    travel_plan, 
                    COUNT(*) as count,
                    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT count FROM short_marriage_stats), 0), 1) as percentage
                FROM couples
                WHERE marriage_duration < 10
                GROUP BY travel_plan
                ORDER BY count DESC
            ),
            long_marriage_stats AS (
                SELECT
                    'long' as category,
                    COUNT(*) as count,
                    AVG(marriage_duration) as avg_marriage_duration
                FROM couples
                WHERE marriage_duration >= 10
            ),
            long_marriage_plans AS (
                SELECT 
                    'long' as category,
                    travel_plan, 
                    COUNT(*) as count,
                    ROUND(COUNT(*) * 100.0 / NULLIF((SELECT count FROM long_marriage_stats), 0), 1) as percentage
                FROM couples
                WHERE marriage_duration >= 10
                GROUP BY travel_plan
                ORDER BY count DESC
            ),
            all_plans AS (
                SELECT 
                    travel_plan, 
                    COUNT(*) as count
                FROM couples
                GROUP BY travel_plan
                ORDER BY count DESC
            )
            SELECT 
                'overall_stats' as result_type, 
                JSON_OBJECT('total_couples', total_couples, 'total_plans', total_plans) as data
            FROM overall_stats
            UNION ALL
            SELECT 'age_groups', JSON_ARRAYAGG(JSON_OBJECT('age_group', age_group, 'count', count, 'percentage', percentage))
            FROM age_groups
            UNION ALL
            SELECT 'older_stats', JSON_OBJECT('count', count, 'avg_marriage_duration', ROUND(avg_marriage_duration, 1))
            FROM older_stats
            UNION ALL
            SELECT 'older_plans', JSON_ARRAYAGG(JSON_OBJECT('travel_plan', travel_plan, 'count', count, 'percentage', percentage))
            FROM older_plans
            UNION ALL
            SELECT 'younger_stats', JSON_OBJECT('count', count, 'avg_marriage_duration', ROUND(avg_marriage_duration, 1))
            FROM younger_stats
            UNION ALL
            SELECT 'younger_plans', JSON_ARRAYAGG(JSON_OBJECT('travel_plan', travel_plan, 'count', count, 'percentage', percentage))
            FROM younger_plans
            UNION ALL
            SELECT 'short_marriage_stats', JSON_OBJECT('count', count, 'avg_marriage_duration', ROUND(avg_marriage_duration, 1))
            FROM short_marriage_stats
            UNION ALL
            SELECT 'short_marriage_plans', JSON_ARRAYAGG(JSON_OBJECT('travel_plan', travel_plan, 'count', count, 'percentage', percentage))
            FROM short_marriage_plans
            UNION ALL
            SELECT 'long_marriage_stats', JSON_OBJECT('count', count, 'avg_marriage_duration', ROUND(avg_marriage_duration, 1))
            FROM long_marriage_stats
            UNION ALL
            SELECT 'long_marriage_plans', JSON_ARRAYAGG(JSON_OBJECT('travel_plan', travel_plan, 'count', count, 'percentage', percentage))
            FROM long_marriage_plans
            UNION ALL
            SELECT 'all_plans', JSON_ARRAYAGG(JSON_OBJECT('travel_plan', travel_plan, 'count', count))
            FROM all_plans
        `);

        // Parse the results into the expected format
        const parsedResults = {};
        results.forEach(row => {
            parsedResults[row.result_type] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        });

        const overallStats = parsedResults.overall_stats || { total_couples: 0, total_plans: 0 };
        const ageDistribution = parsedResults.age_groups || [];
        const olderStats = parsedResults.older_stats || { count: 0, avg_marriage_duration: 0 };
        const olderPlans = parsedResults.older_plans || [];
        const youngerStats = parsedResults.younger_stats || { count: 0, avg_marriage_duration: 0 };
        const youngerPlans = parsedResults.younger_plans || [];
        const shortMarriageStats = parsedResults.short_marriage_stats || { count: 0, avg_marriage_duration: 0 };
        const shortMarriagePlans = parsedResults.short_marriage_plans || [];
        const longMarriageStats = parsedResults.long_marriage_stats || { count: 0, avg_marriage_duration: 0 };
        const longMarriagePlans = parsedResults.long_marriage_plans || [];
        const allPlansPopularity = parsedResults.all_plans || [];

        // Build response structure
        const olderCouplesAnalysis = {
            count: olderStats.count || 0,
            avgMarriageDuration: olderStats.avg_marriage_duration || 'N/A',
            preferences: olderPlans
        };

        const youngerCouplesAnalysis = {
            count: youngerStats.count || 0,
            avgMarriageDuration: youngerStats.avg_marriage_duration || 'N/A',
            preferences: youngerPlans
        };

        const shortMarriageAnalysis = {
            count: shortMarriageStats.count || 0,
            avgMarriageDuration: shortMarriageStats.avg_marriage_duration || 'N/A',
            preferences: shortMarriagePlans
        };

        const longMarriageAnalysis = {
            count: longMarriageStats.count || 0,
            avgMarriageDuration: longMarriageStats.avg_marriage_duration || 'N/A',
            preferences: longMarriagePlans
        };

        const dislikedPlans = [...allPlansPopularity].sort((a, b) => a.count - b.count).slice(0, 5);

        const summary = {
            olderFavorite: olderCouplesAnalysis.preferences.length > 0 ? olderCouplesAnalysis.preferences[0].travel_plan : 'N/A',
            youngerFavorite: youngerCouplesAnalysis.preferences.length > 0 ? youngerCouplesAnalysis.preferences[0].travel_plan : 'N/A',
            allDisliked: dislikedPlans.length > 0 ? dislikedPlans[0].travel_plan : 'N/A',
        };

        const responseData = {
            totalCouples: overallStats.total_couples,
            totalPlans: overallStats.total_plans,
            lastUpdated: new Date().toLocaleString(),
            ageDistribution,
            olderCouplesAnalysis,
            youngerCouplesAnalysis,
            dislikedPlans,
            summary,
            shortMarriageAnalysis,
            longMarriageAnalysis,
            allPlansPopularity
        };

        // Cache the result
        analysisCache = responseData;
        analysisCacheTime = now;
        console.log('Analysis data cached');

        res.json(responseData);

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
