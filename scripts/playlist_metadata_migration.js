const { Sequelize, DataTypes } = require('sequelize');

// Your database configuration
const config = {
    db: {
        host: 'host',
        user: 'ytdiff',
        password: '',
        name: 'vidlist'
    }
};

const sequelize = new Sequelize({
    host: config.db.host,
    dialect: "postgres",
    logging: console.log, // Enable logging to see what's happening
    username: config.db.user,
    password: config.db.password,
    database: config.db.name,
});

async function migratePlaylistMetadataTable() {
    const queryInterface = sequelize.getQueryInterface();

    try {
        console.log('Starting migration for playlist_metadata table...');

        // Check if columns already exist
        const tableDescription = await queryInterface.describeTable('playlist_metadata');

        // Add lastUpdatedByScheduler column
        if (!tableDescription.lastUpdatedByScheduler) {
            console.log('Adding lastUpdatedByScheduler column...');
            await queryInterface.addColumn('playlist_metadata', 'lastUpdatedByScheduler', {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
                comment: "Timestamp of the last update made by the scheduler, default value is current timestamp"
            });

            // Update existing rows to set lastUpdatedByScheduler equal to createdAt
            // Do a full update so all existing rows copy createdAt into the new column.
            // The migration script only runs once (the column is skipped if it already exists),
            // so this is safe and simpler than trying to detect placeholder defaults.
            await sequelize.query(`
                UPDATE playlist_metadata
                SET "lastUpdatedByScheduler" = "createdAt"
            `);

            console.log('✓ lastUpdatedByScheduler column added and initialized');
        } else {
            console.log('✓ lastUpdatedByScheduler column already exists');
        }

        console.log('\n✅ Migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await sequelize.close();
    }
}

// Run the migration
migratePlaylistMetadataTable()
    .then(() => {
        console.log('Script finished');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });