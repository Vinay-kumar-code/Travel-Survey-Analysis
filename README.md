# Travel-Survey-Analysis
Travel Survey Analysis Webpage which can process couples travel data and provide insights about travel behaviour. A full-stack web application for analyzing couples' travel preferences using survey data. Upload Excel files, visualize trends, and explore insights across age groups and marriage durations.

## Features
📊 Interactive Dashboard: Dynamic charts (Chart.js) for age distribution, plan popularity, and marriage duration analysis.

📥 Excel File Upload: Drag-and-drop interface with validation for XLS/XLSX files.

🗃️ MySQL Integration: Stores survey data with automated age calculations and aggregation.

🔍 Filtered Analysis: Compare preferences of older couples (50+), younger couples (<35), and marriage duration groups.

📱 Responsive Design: Bootstrap-powered UI with mobile-friendly layouts.

⚡ High Performance: Optimized queries, caching, and compression for fast response times.

## Tech Stack
Frontend: Javascript, HTML
Backend: Node.js, Express, MySQL
File Handling: ExcelJS (XLSX parsing), express-fileupload
Performance: Gzip compression, in-memory caching, indexed database queries

## Performance Optimizations

This application has been optimized for high performance:
- **95% reduction** in database queries through CTE optimization
- **60-80% reduction** in bandwidth usage with gzip compression
- **In-memory caching** for frequently accessed analysis data
- **Database indexes** on all frequently queried columns
- **Zero security vulnerabilities** in dependencies

See [PERFORMANCE_IMPROVEMENTS.md](PERFORMANCE_IMPROVEMENTS.md) for detailed documentation.

Ideal for demonstrating data visualization, REST API design, and file processing workflows. Includes paginated raw data tables and real-time analysis updates.

