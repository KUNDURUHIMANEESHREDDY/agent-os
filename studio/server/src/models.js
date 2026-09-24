const { DataTypes } = require('sequelize');
const sequelize = require('./db');

// Pipeline Model - Stores node graphs
const Pipeline = sequelize.define('Pipeline', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: '',
  },
  graphData: {
    type: DataTypes.JSON, // Contains nodes and connections layout
    allowNull: false,
    defaultValue: { nodes: [], connections: [] },
  },
});

// RunLog Model - Stores historical runner logs
const RunLog = sequelize.define('RunLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  status: {
    type: DataTypes.ENUM('RUNNING', 'SUCCESS', 'FAILED'),
    defaultValue: 'RUNNING',
    allowNull: false,
  },
  logs: {
    type: DataTypes.JSON, // Array of step-by-step logs [{ nodeId, title, status, output, logText }]
    allowNull: false,
    defaultValue: [],
  },
  output: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: '',
  },
});

Pipeline.hasMany(RunLog, { as: 'logs', foreignKey: 'pipelineId', onDelete: 'CASCADE' });
RunLog.belongsTo(Pipeline, { foreignKey: 'pipelineId' });

module.exports = {
  sequelize,
  Pipeline,
  RunLog,
};
