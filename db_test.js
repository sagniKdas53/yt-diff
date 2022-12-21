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

const vid_list = sequelize.define('vid_list', {
    // Model attributes are defined here
    url: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true
    },
    reference: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    title: {
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
    }
});

sequelize.sync().then(() => {
    console.log('vid_list table created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});