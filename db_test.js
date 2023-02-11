const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize('vidlist', 'ytdiff', 'ytd1ff', {
    host: 'localhost',
    dialect: 'postgres'
});

try {
    sequelize.authenticate().then(
        () => { console.log('Connection has been established successfully.'); })
} catch (error) {
    console.error('Unable to connect to the database:', error);
}

/* This is just a test to see if this is actually as good as I think it is. */
const list_of_play_lists = sequelize.define('list_of_play_lists', {
    // Model attributes are defined here
    url: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true
    },
    play_lists_monitored: {
        type: DataTypes.INTEGER,
        allowNull: false
    }
});

const play_list = sequelize.define('play_list', {
    vid_url: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true
    },
    list_of_play_lists_url: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    vid_title: {
        type: DataTypes.STRING,
        allowNull: false
    },
    downloaded: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    available: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    last_updated: {
        type: DataTypes.DATE,
        allowNull: false
    }
});


play_list.belongsTo(list_of_play_lists, { foreignKey: 'list_of_play_lists_url' });
list_of_play_lists.hasMany(play_list, { foreignKey: 'list_of_play_lists_url' });

sequelize.sync().then(() => {
    console.log('play_list table created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});